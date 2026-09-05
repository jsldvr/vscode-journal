import * as assert from "assert";
import * as vscode from "vscode";
import { buildPatternSpec } from "../../../src/regexMatch";
import {
  RegexSearchCancelledError,
  RegexSearchPool,
  RegexSearchTimeoutError,
} from "../../../src/regexSearchPool";

// Extension Host coverage for the isolated regex search: the worker
// thread must spawn and be terminable inside the Electron extension
// host (not just under plain Node), the compiled worker entry point
// must resolve from the running layout, and a pathological pattern must
// fail without freezing the host.

const CATASTROPHIC = buildPatternSpec("(a+)+$", { useRegex: true });
const PATHOLOGICAL_BODY = `${"a".repeat(48)}!`;

function job(spec: ReturnType<typeof buildPatternSpec>, body: string) {
  return {
    rows: [{ path: "entry.md", title: "Title", body }],
    spec,
    limit: 100,
  };
}

suite("Regex Search Isolation (Extension Host)", function () {
  this.timeout(30000);

  let pool: RegexSearchPool | undefined;

  teardown(async () => {
    await pool?.dispose();
    pool = undefined;
  });

  test("a catastrophic pattern times out in the extension host and the host keeps ticking", async () => {
    pool = new RegexSearchPool(600);
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks++;
    }, 25);
    try {
      await assert.rejects(
        pool.run(job(CATASTROPHIC, PATHOLOGICAL_BODY)),
        RegexSearchTimeoutError
      );
    } finally {
      clearInterval(heartbeat);
    }
    assert.ok(ticks >= 8, `host event loop stalled: ${ticks} ticks`);
  });

  test("an ordinary pattern still runs after a timeout", async () => {
    pool = new RegexSearchPool(600);
    await assert.rejects(
      pool.run(job(CATASTROPHIC, PATHOLOGICAL_BODY)),
      RegexSearchTimeoutError
    );
    const hits = await pool.run(
      job(buildPatternSpec("recovered", {}), "the recovered body text")
    );
    assert.strictEqual(hits.length, 1);
  });

  test("dispose terminates an in-flight worker", async () => {
    pool = new RegexSearchPool(5000);
    const inflight = pool.run(job(CATASTROPHIC, PATHOLOGICAL_BODY));
    const rejection = assert.rejects(inflight, RegexSearchCancelledError);
    await pool.dispose();
    await rejection;
    pool = undefined;
  });

  test("the search command still executes without rejecting", async () => {
    const extension = vscode.extensions.getExtension("jsldvr.vscode-journal");
    assert.ok(extension);
    await extension.activate();
    await vscode.commands.executeCommand("vsJournal.search");
    await vscode.commands.executeCommand("vsJournal.clearSearch");
  });
});
