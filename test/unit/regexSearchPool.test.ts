import * as assert from "assert";
import { buildPatternSpec } from "../../src/regexMatch";
import {
  RegexSearchCancelledError,
  RegexSearchPool,
  RegexSearchRequest,
  RegexSearchTimeoutError,
} from "../../src/regexSearchPool";

// A pattern with catastrophic backtracking against a long non-matching
// line: matching wedges whatever thread evaluates it for far longer
// than any test budget.
const CATASTROPHIC = buildPatternSpec("(a+)+$", { useRegex: true });
const PATHOLOGICAL_BODY = `${"a".repeat(42)}!`;

let nextId = 0;

function jobFor(
  spec: RegexSearchRequest["spec"],
  body: string,
  title = "Title",
  id = ++nextId
): RegexSearchRequest {
  return {
    id,
    rows: [{ path: "entry.md", title, body }],
    spec,
    limit: 100,
  };
}

suite("regexSearchPool", function () {
  this.timeout(20000);

  let pool: RegexSearchPool | undefined;

  setup(() => {
    nextId = 0;
  });

  teardown(async () => {
    await pool?.dispose();
    pool = undefined;
  });

  test("runs an ordinary pattern to completion off the caller's thread", async () => {
    pool = new RegexSearchPool(2000);
    const hits = await pool.run(
      jobFor(buildPatternSpec("ord-\\d+", { useRegex: true }), "see ord-123 now")
    );
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].path, "entry.md");
    assert.ok(hits[0].snippet.toLowerCase().includes("ord-123"));
  });

  test("a catastrophic pattern against the body rejects with a timeout inside the budget", async () => {
    pool = new RegexSearchPool(400);
    const started = Date.now();
    await assert.rejects(
      pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY)),
      RegexSearchTimeoutError
    );
    const elapsed = Date.now() - started;
    assert.ok(
      elapsed < 5000,
      `timeout should fire near the budget, took ${elapsed}ms`
    );
  });

  test("a catastrophic pattern against the title also times out", async () => {
    pool = new RegexSearchPool(400);
    await assert.rejects(
      pool.run(jobFor(CATASTROPHIC, "short body", PATHOLOGICAL_BODY)),
      RegexSearchTimeoutError
    );
  });

  test("the caller's thread keeps running while a wedged worker is timed out", async () => {
    pool = new RegexSearchPool(500);
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks++;
    }, 20);
    try {
      await assert.rejects(
        pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY)),
        RegexSearchTimeoutError
      );
    } finally {
      clearInterval(heartbeat);
    }
    // ~500ms budget / 20ms tick: a blocked host thread would show ~0.
    assert.ok(ticks >= 10, `event loop stalled: only ${ticks} ticks`);
  });

  test("an ordinary search succeeds after a timeout without recreating the pool", async () => {
    pool = new RegexSearchPool(400);
    await assert.rejects(
      pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY)),
      RegexSearchTimeoutError
    );
    const hits = await pool.run(
      jobFor(buildPatternSpec("recovered", {}), "the recovered body")
    );
    assert.strictEqual(hits.length, 1);
  });

  test("repeated timeouts stay bounded and still recover", async () => {
    pool = new RegexSearchPool(300);
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(
        pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY)),
        RegexSearchTimeoutError
      );
    }
    const hits = await pool.run(
      jobFor(buildPatternSpec("alive", {}), "still alive")
    );
    assert.strictEqual(hits.length, 1);
  });

  test("a newer request supersedes the previous run", async () => {
    pool = new RegexSearchPool(5000);
    const stale = pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY));
    const staleAssertion = assert.rejects(stale, RegexSearchCancelledError);
    const fresh = await pool.run(
      jobFor(buildPatternSpec("fresh", {}), "a fresh body")
    );
    assert.strictEqual(fresh.length, 1);
    await staleAssertion;
  });

  test("an older request (lower id) never cancels the current run", async () => {
    pool = new RegexSearchPool(5000);
    // The newer search (id 2) is admitted first because its database
    // read finished first; the older search (id 1) arrives afterwards.
    const current = pool.run(
      jobFor(buildPatternSpec("keeper", {}), "the keeper body text", "T", 2)
    );
    const straggler = pool.run(
      jobFor(CATASTROPHIC, PATHOLOGICAL_BODY, "T", 1)
    );
    await assert.rejects(straggler, RegexSearchCancelledError);
    // The current run must have survived the older arrival.
    const hits = await current;
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].path, "entry.md");
  });

  test("a repeated id is rejected as stale without disturbing the current run", async () => {
    pool = new RegexSearchPool(5000);
    const current = pool.run(
      jobFor(buildPatternSpec("held", {}), "held body", "T", 7)
    );
    await assert.rejects(
      pool.run(jobFor(buildPatternSpec("x", {}), "x", "T", 7)),
      RegexSearchCancelledError
    );
    const hits = await current;
    assert.strictEqual(hits.length, 1);
  });

  test("dispose settles an in-flight run and rejects further requests", async () => {
    pool = new RegexSearchPool(5000);
    const inflight = pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY));
    const inflightAssertion = assert.rejects(
      inflight,
      RegexSearchCancelledError
    );
    await pool.dispose();
    await inflightAssertion;
    await assert.rejects(
      pool.run(jobFor(buildPatternSpec("x", {}), "x")),
      RegexSearchCancelledError
    );
    pool = undefined;
  });

  test("at most one worker is live under a burst, and dispose leaves none", async () => {
    pool = new RegexSearchPool(5000);
    const rejections: Promise<void>[] = [];
    let peak = 0;
    for (let i = 0; i < 10; i++) {
      rejections.push(
        assert.rejects(
          pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY)),
          RegexSearchCancelledError
        )
      );
      // Yield so each supersession's terminate() can be observed.
      await new Promise((resolve) => setImmediate(resolve));
      peak = Math.max(peak, countRegexWorkers());
    }
    const last = pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY));
    const lastAssertion = assert.rejects(last, RegexSearchCancelledError);

    // retireCurrent() awaits each terminate() before the next spawn, so
    // the burst never stacks threads.
    assert.ok(peak <= 2, `burst stacked ${peak} live workers`);

    await pool.dispose();
    await Promise.all(rejections);
    await lastAssertion;
    // dispose() returns only after every worker it started has exited.
    assert.strictEqual(
      countRegexWorkers(),
      0,
      "dispose returned with workers still live"
    );
    pool = undefined;
  });

  test("an invalid pattern that reaches the worker rejects, not hangs", async () => {
    pool = new RegexSearchPool(2000);
    await assert.rejects(
      pool.run(jobFor({ source: "(", flags: "" }, "body")),
      /Invalid regular expression/
    );
  });
});

// Count of live regex worker threads owned by this process. Stable
// since Node 17; entries are resource-type strings such as "Worker".
function countRegexWorkers(): number {
  return process
    .getActiveResourcesInfo()
    .filter((entry) => entry === "Worker").length;
}
