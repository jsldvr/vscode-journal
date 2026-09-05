import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { BlogIndex, RegexSearchTimeoutError } from "../../src/blogIndex";

// Standalone probe process for regexSearchHostProbe.test.ts. It drives
// real catastrophic-backtracking searches through the production
// BlogIndex.search path and reports the outcomes as a single JSON line
// on stdout. The parent test enforces an independent outer deadline by
// killing this process, so a regression to synchronous host-thread
// matching shows up as a killed process, not a hung test runner.
//
// Every case that feeds a catastrophic pattern to BlogIndex.search
// belongs here, not in the in-process unit suites: a regression would
// wedge the whole Mocha process, and its same-thread timeout could not
// interrupt it.
//
// This file is compiled (test tsconfig includes test/unit/**) but is
// not named *.test.js, so Mocha never picks it up as a suite.

const PATHOLOGICAL_PATTERN = "(a+)+$";
const PATHOLOGICAL_TEXT = `${"a".repeat(60)}!`;
const HEARTBEAT_INTERVAL_MS = 25;

function entryMarkdown(title: string, body: string): string {
  return `---\ntitle: ${title}\ndate: 2026-07-24 10:00:00\ntags: []\n---\n\n${body}\n`;
}

async function withIndex<T>(
  entries: { file: string; title: string; body: string }[],
  fn: (index: BlogIndex) => Promise<T>
): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-probe-"));
  try {
    for (const entry of entries) {
      await fs.writeFile(
        path.join(dir, entry.file),
        entryMarkdown(entry.title, entry.body)
      );
    }
    const index = await BlogIndex.open(dir);
    await index.reconcile();
    try {
      return await fn(index);
    } finally {
      await index.close();
    }
  } finally {
    await fs.remove(dir).catch(() => undefined);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof RegexSearchTimeoutError;
}

// A catastrophic search against the body times out, and the host event
// loop keeps ticking while the worker is wedged.
async function bodyTimeoutAndHeartbeat(): Promise<Record<string, unknown>> {
  return withIndex(
    [{ file: "boom.md", title: "Boom", body: PATHOLOGICAL_TEXT }],
    async (index) => {
      let ticks = 0;
      const heartbeat = setInterval(() => {
        ticks++;
      }, HEARTBEAT_INTERVAL_MS);
      const started = Date.now();
      try {
        await index.search(PATHOLOGICAL_PATTERN, { useRegex: true });
        return { ok: false, reason: "resolved" };
      } catch (error) {
        return {
          ok: isTimeout(error),
          elapsedMs: Date.now() - started,
          ticks,
        };
      } finally {
        clearInterval(heartbeat);
      }
    }
  );
}

// A catastrophic pattern that only the title matches also times out.
async function titleTimeout(): Promise<Record<string, unknown>> {
  return withIndex(
    [{ file: "boomtitle.md", title: PATHOLOGICAL_TEXT, body: "short body" }],
    async (index) => {
      try {
        await index.search(PATHOLOGICAL_PATTERN, { useRegex: true });
        return { ok: false, reason: "resolved" };
      } catch (error) {
        return { ok: isTimeout(error) };
      }
    }
  );
}

// After a timeout, an ordinary literal search and an ordinary regex
// search both succeed with no reopen.
async function recoveryAfterTimeout(): Promise<Record<string, unknown>> {
  return withIndex(
    [
      { file: "boom.md", title: "Boom", body: PATHOLOGICAL_TEXT },
      { file: "calm.md", title: "Calm", body: "an ordinary searchable body" },
    ],
    async (index) => {
      try {
        await index.search(PATHOLOGICAL_PATTERN, { useRegex: true });
        return { ok: false, reason: "resolved" };
      } catch (error) {
        if (!isTimeout(error)) {
          return { ok: false, reason: "not-timeout" };
        }
      }
      const literal = await index.search("ordinary searchable");
      const regex = await index.search("ord\\w+", { useRegex: true });
      return {
        ok: literal.entries.length === 1 && regex.entries.length === 1,
        literal: literal.entries.length,
        regex: regex.entries.length,
      };
    }
  );
}

// Finding-1 regression: two overlapping catastrophic searches. Their
// database reads can complete out of submission order (node-sqlite3
// does not serialize overlapping reads), but the newer search
// (submitted second) must still get a terminal timeout -- an older
// search's late arrival must never cancel the newer one's worker into
// a silent RegexSearchCancelledError.
async function newerOverlappingSearchStillTerminates(): Promise<
  Record<string, unknown>
> {
  return withIndex(
    [{ file: "boom.md", title: "Boom", body: PATHOLOGICAL_TEXT }],
    async (index) => {
      const trials = 3;
      for (let i = 0; i < trials; i++) {
        const older = index.search(PATHOLOGICAL_PATTERN, { useRegex: true });
        const newer = index.search(PATHOLOGICAL_PATTERN, { useRegex: true });
        const [olderResult, newerResult] = await Promise.allSettled([
          older,
          newer,
        ]);
        if (olderResult.status !== "rejected") {
          return { ok: false, reason: `older resolved on trial ${i}` };
        }
        if (
          newerResult.status !== "rejected" ||
          !isTimeout(newerResult.reason)
        ) {
          return {
            ok: false,
            reason: `newer search did not time out on trial ${i}: ${
              newerResult.status === "rejected"
                ? (newerResult.reason as Error).constructor.name
                : "resolved"
            }`,
          };
        }
      }
      return { ok: true, trials };
    }
  );
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {};
  report.bodyTimeout = await bodyTimeoutAndHeartbeat();
  report.titleTimeout = await titleTimeout();
  report.recovery = await recoveryAfterTimeout();
  report.newerOverlap = await newerOverlappingSearchStillTerminates();

  const allOk = Object.values(report).every(
    (entry) => (entry as { ok?: boolean }).ok === true
  );
  process.stdout.write(`${JSON.stringify({ allOk, ...report })}\n`);
  process.exit(allOk ? 0 : 1);
}

main().catch((error) => {
  process.stdout.write(
    `${JSON.stringify({ allOk: false, crash: String(error) })}\n`
  );
  process.exit(2);
});
