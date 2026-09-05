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

// A regex-search request. `id` is a caller-assigned, strictly
// increasing sequence number in *search submission* order. The pool
// admits requests by `id`, not by arrival order, because the database
// read that precedes a request can finish out of submission order
// (node-sqlite3 does not serialize overlapping reads) -- without the id
// an older search that reads slowly could arrive last and cancel the
// worker a newer search already owns.
export interface RegexSearchRequest {
  id: number;
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
// and one deadline timer, settles its `done` promise exactly once
// (success, timeout, cancellation, or worker failure), and exposes
// `whenTerminated()` so the pool can wait for the worker thread to
// actually exit before starting or disposing.
class RegexSearchRun {
  readonly done: Promise<RegexSearchHit[]>;

  private worker: Worker | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settled = false;
  private terminated: Promise<void> = Promise.resolve();
  private resolveDone: (hits: RegexSearchHit[]) => void = () => undefined;
  private rejectDone: (error: Error) => void = () => undefined;

  constructor(
    private readonly job: RegexSearchJob,
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
    this.worker.postMessage(this.job);
  }

  cancel(error: Error): void {
    this.fail(error);
  }

  // Resolves when this run's worker thread has fully exited (or
  // immediately if it never started one). Safe to await repeatedly.
  whenTerminated(): Promise<void> {
    return this.terminated;
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
      // Keep the termination promise so the pool can wait for the
      // thread to be gone: merely calling terminate() and moving on
      // would let a burst of superseded searches stack live threads.
      this.terminated = worker.terminate().then(
        () => undefined,
        () => undefined
      );
    }
    this.onFinished(this);
  }
}

// Bounds the isolated regex scan to a single live worker. A request is
// admitted only if its id is strictly newer than the last admitted id
// (so a reordered older search cannot cancel a newer one's worker);
// admitting a request cancels the previous run and waits for its worker
// to exit before spawning the replacement; disposal cancels the current
// run and waits for every worker it started to exit. There is never a
// synchronous host-thread fallback -- a worker failure is reported as
// an error, and the next search simply starts a fresh worker.
export class RegexSearchPool {
  private current: RegexSearchRun | undefined;
  private latestRequestId = 0;
  private disposed = false;
  private readonly draining = new Set<RegexSearchRun>();

  constructor(private readonly budgetMs: number = REGEX_SEARCH_BUDGET_MS) {}

  async run(request: RegexSearchRequest): Promise<RegexSearchHit[]> {
    if (this.disposed) {
      throw new RegexSearchCancelledError("regex search pool is disposed");
    }
    if (request.id <= this.latestRequestId) {
      // A newer search already owns (or has owned) the pool. Reject
      // this stale request without disturbing the current worker.
      throw new RegexSearchCancelledError("superseded by a newer search");
    }
    this.latestRequestId = request.id;
    await this.retireCurrent(
      new RegexSearchCancelledError("superseded by a newer search")
    );
    if (this.disposed || request.id !== this.latestRequestId) {
      // Disposed, or a still-newer request arrived while the previous
      // worker was terminating -- this one is already obsolete.
      throw new RegexSearchCancelledError("superseded by a newer search");
    }
    const job: RegexSearchJob = {
      rows: request.rows,
      spec: request.spec,
      limit: request.limit,
    };
    const run = new RegexSearchRun(job, this.budgetMs, (finished) => {
      if (this.current === finished) {
        this.current = undefined;
      }
    });
    this.current = run;
    run.start();
    return run.done;
  }

  // Cancels the active run and waits for its worker thread to actually
  // exit before returning, so at most one worker is ever live even
  // under a burst of superseding searches.
  private async retireCurrent(reason: Error): Promise<void> {
    const previous = this.current;
    this.current = undefined;
    if (!previous) {
      return;
    }
    previous.cancel(reason);
    this.draining.add(previous);
    try {
      await previous.whenTerminated();
    } finally {
      this.draining.delete(previous);
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.retireCurrent(
      new RegexSearchCancelledError("regex search pool is disposed")
    );
    // Wait out any worker still terminating inside a concurrent run().
    await Promise.allSettled(
      [...this.draining].map((run) => run.whenTerminated())
    );
  }
}
