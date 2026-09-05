import * as assert from "assert";
import { Worker } from "worker_threads";
import { buildPatternSpec } from "../../src/regexMatch";
import {
  RegexSearchCancelledError,
  RegexSearchPool,
  RegexSearchRequest,
  RegexSearchTimeoutError,
  regexWorkerEntryPath,
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

interface FactoryState {
  created: number;
  alive: number;
  peak: number;
}

// Instruments real worker creation and exit so the resource-bound
// assertions observe the actual thread lifecycle rather than a proxy.
// `terminateDelayMs` widens the termination window on purpose, so a
// test can submit further requests while a worker is still exiting.
function countingWorkerFactory(terminateDelayMs = 0): {
  make: () => Worker;
  state: FactoryState;
} {
  const state: FactoryState = { created: 0, alive: 0, peak: 0 };
  return {
    state,
    make: () => {
      const worker = new Worker(regexWorkerEntryPath());
      state.created++;
      state.alive++;
      state.peak = Math.max(state.peak, state.alive);
      worker.once("exit", () => {
        state.alive--;
      });
      if (terminateDelayMs > 0) {
        const realTerminate = worker.terminate.bind(worker);
        (worker as unknown as { terminate: () => Promise<number> }).terminate =
          async () => {
            await new Promise((resolve) =>
              setTimeout(resolve, terminateDelayMs)
            );
            return realTerminate();
          };
      }
      return worker;
    },
  };
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 10000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

suite("regexSearchPool", function () {
  this.timeout(30000);

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
    const straggler = pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY, "T", 1));
    await assert.rejects(straggler, RegexSearchCancelledError);
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

  test("overlapping searches never run two workers at once, and dispose leaves none", async () => {
    const factory = countingWorkerFactory();
    pool = new RegexSearchPool(5000, factory.make);
    const rejections: Promise<unknown>[] = [];
    for (let i = 0; i < 6; i++) {
      rejections.push(
        assert.rejects(
          pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY)),
          RegexSearchCancelledError
        )
      );
      // Each supersession must wait for the prior worker to exit before
      // spawning, so `created` only advances once the barrier clears.
      await waitUntil(() => factory.state.created === i + 1);
      assert.ok(
        factory.state.alive <= 1,
        `two workers alive after spawn ${i + 1}: ${factory.state.alive}`
      );
    }
    const lastRejection = assert.rejects(
      pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY)),
      RegexSearchCancelledError
    );
    await waitUntil(() => factory.state.created === 7);

    assert.strictEqual(
      factory.state.peak,
      1,
      `peak concurrent workers was ${factory.state.peak}`
    );

    await pool.dispose();
    await Promise.all([...rejections, lastRejection]);
    assert.strictEqual(
      factory.state.alive,
      0,
      `${factory.state.alive} workers still alive after dispose`
    );
    assert.strictEqual(factory.state.created, 7);
    pool = undefined;
  });

  test("a request arriving while a worker is still terminating cannot spawn a second worker", async () => {
    // Reproduces the concurrent-replacement interleave directly: A is
    // running, B preempts it (A begins a deliberately slow terminate),
    // then C and D are submitted synchronously *before* A has exited.
    // With a per-call barrier those later requests see no `current` and
    // spawn immediately (peak > 1). With the shared barrier they wait.
    const factory = countingWorkerFactory(200);
    pool = new RegexSearchPool(5000, factory.make);

    const a = pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY, "T", 1));
    const aAssert = assert.rejects(a, RegexSearchCancelledError);
    await waitUntil(() => factory.state.created === 1);

    // No await between these: B nulls `current` and starts A's slow
    // termination; C and D arrive during that window.
    const b = pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY, "T", 2));
    const c = pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY, "T", 3));
    const d = pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY, "T", 4));
    const laterAsserts = [
      assert.rejects(b, RegexSearchCancelledError),
      assert.rejects(c, RegexSearchCancelledError),
      assert.rejects(d, RegexSearchCancelledError),
    ];

    // Long enough for A to finish terminating and any unbarriered spawn
    // to have happened.
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.strictEqual(
      factory.state.peak,
      1,
      `a second worker ran during termination: peak ${factory.state.peak}`
    );

    const last = pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY, "T", 5));
    const lastAssert = assert.rejects(last, RegexSearchCancelledError);
    await pool.dispose();
    await Promise.all([aAssert, ...laterAsserts, lastAssert]);
    assert.strictEqual(
      factory.state.alive,
      0,
      `${factory.state.alive} workers still alive after dispose`
    );
    pool = undefined;
  });

  test("dispose waits for the worker to exit after a run completed successfully", async () => {
    const factory = countingWorkerFactory();
    pool = new RegexSearchPool(2000, factory.make);
    const hits = await pool.run(
      jobFor(buildPatternSpec("hi", {}), "please say hi")
    );
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(factory.state.created, 1);
    await pool.dispose();
    assert.strictEqual(
      factory.state.alive,
      0,
      "worker still alive after dispose following a successful run"
    );
    pool = undefined;
  });

  test("dispose waits for the worker to exit after a run timed out", async () => {
    const factory = countingWorkerFactory();
    pool = new RegexSearchPool(300, factory.make);
    await assert.rejects(
      pool.run(jobFor(CATASTROPHIC, PATHOLOGICAL_BODY)),
      RegexSearchTimeoutError
    );
    await pool.dispose();
    assert.strictEqual(
      factory.state.alive,
      0,
      "worker still alive after dispose following a timeout"
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
