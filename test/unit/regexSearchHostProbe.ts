import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { BlogIndex, RegexSearchTimeoutError } from "../../src/blogIndex";

// Standalone probe process for regexSearchHostProbe.test.ts. It drives
// a real catastrophic-backtracking search through the production
// BlogIndex.search path and reports, as a single JSON line on stdout,
// whether the call returned within its budget and how many event-loop
// ticks the *main* thread got while the worker was wedged. The parent
// test enforces an independent outer timeout by killing this process,
// so a regression to synchronous host-thread matching shows up as a
// killed process, not a hung test runner.
//
// This file is compiled (test tsconfig includes test/unit/**) but is
// not named *.test.js, so Mocha never picks it up as a suite.

const PATHOLOGICAL_PATTERN = "(a+)+$";
const PATHOLOGICAL_BODY = `${"a".repeat(60)}!`;
const HEARTBEAT_INTERVAL_MS = 25;

function entryMarkdown(body: string): string {
  return `---\ntitle: Probe\ndate: 2026-07-24 10:00:00\ntags: []\n---\n\n${body}\n`;
}

async function main(): Promise<void> {
  const entriesDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "vs-journal-probe-")
  );
  const entryPath = path.join(entriesDir, "probe.md");
  await fs.writeFile(entryPath, entryMarkdown(PATHOLOGICAL_BODY));

  const index = await BlogIndex.open(entriesDir);
  await index.reconcile();

  let ticks = 0;
  const heartbeat = setInterval(() => {
    ticks++;
  }, HEARTBEAT_INTERVAL_MS);

  const started = Date.now();
  let report: Record<string, unknown>;
  try {
    await index.search(PATHOLOGICAL_PATTERN, { useRegex: true });
    report = { outcome: "resolved", elapsedMs: Date.now() - started, ticks };
  } catch (error) {
    clearInterval(heartbeat);
    if (error instanceof RegexSearchTimeoutError) {
      report = { outcome: "timeout", elapsedMs: Date.now() - started, ticks };
    } else {
      report = {
        outcome: "error",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } finally {
    clearInterval(heartbeat);
  }

  await index.close();
  await fs.remove(entriesDir).catch(() => undefined);

  process.stdout.write(`${JSON.stringify(report)}\n`);
  process.exit(report.outcome === "timeout" ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ outcome: "crash", message: String(error) })}\n`
  );
  process.exit(2);
});
