import * as path from "path";
import { Worker } from "worker_threads";
import {
  InvalidSearchPatternError,
  RegexSearchHit,
  RegexSearchJob,
} from "./regexMatch";

// Per-request wall-clock budget for the isolated regex scan. Measured
// once, from the moment the job is handed to the pool until the worker
// returns a result -- it is NOT reset per entry. A pattern that blows
// this budget (for example catastrophic backtracking such as
// /(a+)+$/ against a long non-matching string) has its worker
// terminated and the request rejected with RegexSearchTimeoutError, so
// the extension host thread is never held.
export const REGEX_SEARCH_BUDGET_MS = 2000;

// Base class for every non-success outcome the pool itself produces, so
// callers can distinguish "the worker path failed" from an ordinary
// InvalidSearchPatternError or a database error.
export class RegexSearchError extends Error {}

// The budget elapsed before the worker returned. Recoverable: the next
// search spawns a fresh worker.
export class RegexSearchTimeoutError extends RegexSearchError {}

// The run was abandoned because a newer search superseded it or the
// pool was disposed. Callers treat this as "no result to show", never
// as a failure to surface.
export class RegexSearchCancelledError extends RegexSearchError {}

// The worker could not be started or exited unexpectedly. Distinct from
// a timeout: there is no partial result and no pathological pattern to
// simplify.
export class RegexSearchUnavailableError extends RegexSearchError {}

export interface RegexSearchRequest {
  rows: RegexSearchJob["rows"];
  spec: RegexSearchJob["spec"];
  limit: number;
}

type WorkerResponse =
  | { type: "result"; hits: RegexSearchHit[] }
  | { type: "invalidPattern" }
  | { type: "error"; message: string };

// Resolves to the compiled worker entry point. blogIndex.js and
// regexWorker.js are always emitted as siblings -- out/ for the running
// extension, test/results/compiled/src/ for the test build -- so a
// __dirname-relative join is correct in both layouts and inside the
// packaged VSIX.
function workerEntryPath(): string {
  return path.join(__dirname, "regexWorker.js");
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A single in-flight regex-search execution: owns exactly one Worker
// and one deadline timer, and settles its `done` promise exactly once
// (success, timeout, cancellation, or worker failure), tearing down the
// worker and timer on the way out.
class RegexSearchRun {
  readonly done: Promise<RegexSearchHit[]>;

  private worker: Worker | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settled = false;
  private resolveDone: (hits: RegexSearchHit[]) => void = () => undefined;
  private rejectDone: (error: Error) => void = () => undefined;

  constructor(
    private readonly request: RegexSearchRequest,
    private readonly budgetMs: number,
    private readonly onFinished: (run: RegexSearchRun) => void
  ) {
    this.done = new Promise<RegexSearchHit[]>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  start(): void {
    try {
      this.worker = new Worker(workerEntryPath());
    } catch (error) {
      this.fail(
        new RegexSearchUnavailableError(
          `regex worker failed to start: ${describeError(error)}`
        )
      );
      return;
    }
    this.timer = setTimeout(() => {
      this.fail(
        new RegexSearchTimeoutError(
          `regex search exceeded its ${this.budgetMs} ms budget`
        )
      );
    }, this.budgetMs);
    this.worker.on("message", (response: WorkerResponse) =>
      this.handleMessage(response)
    );
    this.worker.on("error", (error) => {
      this.fail(
        new RegexSearchUnavailableError(
          `regex worker crashed: ${describeError(error)}`
        )
      );
    });
    this.worker.on("exit", (code) => {
      this.fail(
        new RegexSearchUnavailableError(
          `regex worker exited before returning a result (code ${code})`
        )
      );
    });
    this.worker.postMessage(this.request);
  }

  cancel(error: Error): void {
    this.fail(error);
  }

  private handleMessage(response: WorkerResponse): void {
    if (response.type === "result") {
      this.succeed(response.hits);
      return;
    }
    if (response.type === "invalidPattern") {
      this.fail(new InvalidSearchPatternError("Invalid regular expression"));
      return;
    }
    this.fail(new RegexSearchError(`regex worker error: ${response.message}`));
  }

  private succeed(hits: RegexSearchHit[]): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.teardown();
    this.resolveDone(hits);
  }

  private fail(error: Error): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.teardown();
    this.rejectDone(error);
  }

  private teardown(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const worker = this.worker;
    this.worker = undefined;
    if (worker) {
      worker.removeAllListeners();
      void worker.terminate();
    }
    this.onFinished(this);
  }
}

// Bounds the isolated regex scan to a single live worker: a new request
// tears down any in-flight run (and terminates its worker) before
// starting its own, and disposal terminates the current run. There is
// never a synchronous host-thread fallback -- a worker failure is
// reported as an error, and the next search simply starts a fresh
// worker.
export class RegexSearchPool {
  private current: RegexSearchRun | undefined;
  private disposed = false;

  constructor(private readonly budgetMs: number = REGEX_SEARCH_BUDGET_MS) {}

  run(request: RegexSearchRequest): Promise<RegexSearchHit[]> {
    if (this.disposed) {
      return Promise.reject(
        new RegexSearchCancelledError("regex search pool is disposed")
      );
    }
    this.cancelCurrent(
      new RegexSearchCancelledError("superseded by a newer search")
    );
    const run = new RegexSearchRun(request, this.budgetMs, (finished) => {
      if (this.current === finished) {
        this.current = undefined;
      }
    });
    this.current = run;
    run.start();
    return run.done;
  }

  private cancelCurrent(error: Error): void {
    const run = this.current;
    this.current = undefined;
    run?.cancel(error);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelCurrent(
      new RegexSearchCancelledError("regex search pool is disposed")
    );
  }
}
