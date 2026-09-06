import * as assert from "assert";
import { fork } from "child_process";
import * as path from "path";

// Runs the microtask-loop-prone lifecycle scenario in a separate process
// (indexLifecycleProbe.js) and enforces an independent outer deadline
// here by killing that process. A same-thread Mocha timeout cannot
// protect this runner from a regression that starves the event loop;
// forking can.
const PROBE = path.resolve(__dirname, "indexLifecycleProbe.js");
const OUTER_DEADLINE_MS = 15000;

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

suite("index lifecycle escalation safety (isolated process)", function () {
  this.timeout(OUTER_DEADLINE_MS + 10000);

  test("ensure(true) after an unresolvable passive open completes in bounded time", async () => {
    const result = await runProbe();

    assert.strictEqual(
      result.killedByDeadline,
      false,
      `probe had to be killed after ${OUTER_DEADLINE_MS}ms -- the escalation loop regressed. Output: ${result.stdout}`
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
      ensureTrueAfterUnresolvable: { ok: boolean; reason?: string };
    };
    assert.strictEqual(report.allOk, true, JSON.stringify(report));
  });
});
