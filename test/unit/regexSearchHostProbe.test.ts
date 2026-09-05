import * as assert from "assert";
import { fork } from "child_process";
import * as path from "path";

// Runs the real pathological search through the production BlogIndex
// path in a separate process (regexSearchHostProbe.js) and enforces an
// independent outer deadline here by killing that process. A same-thread
// Mocha timeout could not protect this runner from a regression to
// synchronous host-thread matching; forking can.
const PROBE = path.resolve(__dirname, "regexSearchHostProbe.js");
const OUTER_DEADLINE_MS = 20000;

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
  this.timeout(OUTER_DEADLINE_MS + 15000);

  test("a catastrophic search returns a timeout while the host thread keeps ticking", async () => {
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
      outcome: string;
      elapsedMs: number;
      ticks: number;
    };

    assert.strictEqual(report.outcome, "timeout", result.stdout);
    assert.ok(
      report.elapsedMs < 10000,
      `search took ${report.elapsedMs}ms, expected it near the budget`
    );
    assert.ok(
      report.ticks >= 10,
      `host event loop only ticked ${report.ticks} times during the wedged search`
    );
  });
});
