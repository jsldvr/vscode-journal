import { parentPort } from "worker_threads";
import {
  InvalidSearchPatternError,
  RegexSearchJob,
  runRegexSearch,
} from "./regexMatch";

// Worker-thread entry point for the matchCase/wholeWord/useRegex scan.
// The scan is CPU-bound and a catastrophic pattern wedges *this* thread
// synchronously (execution never returns to post a response); the
// parent thread owns the deadline and reclaims a wedged worker with
// worker.terminate(), so nothing here needs its own time limit.
//
// Imports are deliberately limited to worker_threads and the pure
// regexMatch module: this file must not pull in sqlite3 or vscode.

if (!parentPort) {
  throw new Error("regexWorker.ts must be run as a worker thread");
}

const port = parentPort;

port.on("message", (job: RegexSearchJob) => {
  try {
    const hits = runRegexSearch(job);
    port.postMessage({ type: "result", hits });
  } catch (error) {
    if (error instanceof InvalidSearchPatternError) {
      port.postMessage({ type: "invalidPattern" });
      return;
    }
    port.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
