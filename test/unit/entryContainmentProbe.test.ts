import * as assert from "assert";
import { fork } from "child_process";
import * as path from "path";

// Runs the junction-cycle scan scenario in a separate process
// (entryContainmentProbe.js) and enforces an independent outer deadline
// here by killing it. A same-thread Mocha timeout cannot protect this
// runner from a regression that follows directory links and recurses
// without bound; forking can.
const PROBE = path.resolve(__dirname, "entryContainmentProbe.js");
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

suite("entry containment scan safety (isolated process)", function () {
  this.timeout(OUTER_DEADLINE_MS + 15000);

  test("a junction-cycle entries tree scans in bounded time and indexes only real files", async () => {
    const result = await runProbe();

    assert.strictEqual(
      result.killedByDeadline,
      false,
      `probe had to be killed after ${OUTER_DEADLINE_MS}ms -- the scan followed a directory link. Output: ${result.stdout}`
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
    const report = JSON.parse(line) as { allOk: boolean; scanned?: string[] };
    assert.strictEqual(report.allOk, true, JSON.stringify(report));
  });
});
