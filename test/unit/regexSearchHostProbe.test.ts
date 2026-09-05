import * as assert from "assert";
import { fork } from "child_process";
import * as path from "path";

// Runs the real pathological searches through the production BlogIndex
// path in a separate process (regexSearchHostProbe.js) and enforces an
// independent outer deadline here by killing that process. A same-thread
// Mocha timeout could not protect this runner from a regression to
// synchronous host-thread matching; forking can.
const PROBE = path.resolve(__dirname, "regexSearchHostProbe.js");
const OUTER_DEADLINE_MS = 45000;

interface ProbeResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  killedByDeadline: boolean;
}

function runProbe(): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    const child = fork(PROBE, [], { silent: true });
    let stdout = "";
    let killedByDeadline = false;

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    const deadline = setTimeout(() => {
      killedByDeadline = true;
      child.kill("SIGKILL");
    }, OUTER_DEADLINE_MS);

    child.on("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(deadline);
      resolve({ code, signal, stdout, killedByDeadline });
    });
  });
}

suite("regex search host responsiveness (isolated process)", function () {
  this.timeout(OUTER_DEADLINE_MS + 20000);

  test("catastrophic searches time out cleanly, recover, and never stall a newer overlapping search", async () => {
    const result = await runProbe();

    assert.strictEqual(
      result.killedByDeadline,
      false,
      `probe had to be killed after ${OUTER_DEADLINE_MS}ms -- host thread was blocked. Output: ${result.stdout}`
    );
    assert.strictEqual(
      result.code,
      0,
      `probe exited non-zero. Output: ${result.stdout}`
    );

    const line = result.stdout
      .split("\n")
      .map((entry) => entry.trim())
      .filter(Boolean)
      .pop();
    assert.ok(line, `probe produced no report. Output: ${result.stdout}`);
    const report = JSON.parse(line) as {
      allOk: boolean;
      bodyTimeout: { ok: boolean; elapsedMs?: number; ticks?: number };
      titleTimeout: { ok: boolean };
      recovery: { ok: boolean };
      newerOverlap: { ok: boolean; reason?: string };
    };

    assert.strictEqual(report.allOk, true, JSON.stringify(report));
    assert.ok(
      (report.bodyTimeout.elapsedMs ?? Infinity) < 10000,
      `body search took ${report.bodyTimeout.elapsedMs}ms, expected near the budget`
    );
    assert.ok(
      (report.bodyTimeout.ticks ?? 0) >= 10,
      `host event loop only ticked ${report.bodyTimeout.ticks} times during the wedged search`
    );
    assert.strictEqual(report.newerOverlap.ok, true, report.newerOverlap.reason);
  });
});
