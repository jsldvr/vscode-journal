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

// Injectable so tests can observe worker creation and exit; production
// uses the real compiled worker entry point.
export type RegexWorkerFactory = () => Worker;

type WorkerResponse =
  | { type: "result"; hits: RegexSearchHit[] }
  | { type: "invalidPattern" }
  | { type: "error"; message: string };

// blogIndex.js and regexWorker.js are always emitted as siblings --
// out/ for the running extension, test/results/compiled/src/ for the
// test build -- so a __dirname-relative join is correct in both layouts
// and inside the packaged VSIX. Exported so tests can spawn the same
// worker through an instrumented factory.
export function regexWorkerEntryPath(): string {
  return path.join(__dirname, "regexWorker.js");
}

function spawnRegexWorker(): Worker {
  return new Worker(regexWorkerEntryPath());
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// A single in-flight regex-search execution: owns exactly one Worker
// and one deadline timer, settles its `done` promise exactly once
// (success, timeout, cancellation, or worker failure), removes only the
// listeners it added, and exposes `whenTerminated()` so the pool can
// wait for the worker thread to actually exit.
class RegexSearchRun {
  readonly done: Promise<RegexSearchHit[]>;

  private worker: Worker | undefined;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private settled = false;
  private terminated: Promise<void> = Promise.resolve();
  private resolveDone: (hits: RegexSearchHit[]) => void = () => undefined;
  private rejectDone: (error: Error) => void = () => undefined;

  private readonly onMessage = (response: WorkerResponse): void =>
    this.handleMessage(response);
  private readonly onError = (error: unknown): void =>
    this.fail(
      new RegexSearchUnavailableError(
        `regex worker crashed: ${describeError(error)}`
      )
    );
  private readonly onExit = (code: number): void =>
    this.fail(
      new RegexSearchUnavailableError(
        `regex worker exited before returning a result (code ${code})`
      )
    );

  constructor(
    private readonly job: RegexSearchJob,
    private readonly budgetMs: number,
    private readonly spawn: RegexWorkerFactory,
    private readonly onFinished: (run: RegexSearchRun) => void
  ) {
    this.done = new Promise<RegexSearchHit[]>((resolve, reject) => {
      this.resolveDone = resolve;
      this.rejectDone = reject;
    });
  }

  start(): void {
    try {
      this.worker = this.spawn();
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
    this.worker.on("message", this.onMessage);
    this.worker.on("error", this.onError);
    this.worker.on("exit", this.onExit);
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
      worker.off("message", this.onMessage);
      worker.off("error", this.onError);
      worker.off("exit", this.onExit);
      // Keep the termination promise so the pool can wait for the
      // thread to be gone before spawning a replacement or resolving
      // dispose().
      this.terminated = worker.terminate().then(
        () => undefined,
        () => undefined
      );
    }
    this.onFinished(this);
  }
}

// Keeps the isolated regex scan to a single live worker at any instant,
// across concurrent run() calls, and never returns from dispose() while
// a worker it started is still exiting.
//
// A request is admitted only if its id is strictly newer than the last
// admitted id (a reordered older search cannot cancel a newer one's
// worker). Admitting a request preempts the running search immediately,
// then waits at a shared barrier until every worker started so far has
// actually exited before spawning -- so overlapping searches cannot
// stack threads even though each run() call is its own async task.
// There is never a synchronous host-thread fallback: a worker failure
// is reported as an error and the next search starts a fresh worker.
export class RegexSearchPool {
  private current: RegexSearchRun | undefined;
  private latestRequestId = 0;
  private disposed = false;
  private readonly pendingTerminations = new Set<Promise<void>>();

  constructor(
    private readonly budgetMs: number = REGEX_SEARCH_BUDGET_MS,
    private readonly spawn: RegexWorkerFactory = spawnRegexWorker
  ) {}

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

    // Preempt the running search now; its worker begins terminating.
    this.cancelCurrent(
      new RegexSearchCancelledError("superseded by a newer search")
    );
    // Barrier: block every path to spawning until all outstanding
    // worker terminations have completed. Shared across concurrent
    // run() calls, so a burst cannot get two workers running at once.
    await this.drainTerminations();

    if (this.disposed || request.id !== this.latestRequestId) {
      // Disposed, or a still-newer request arrived while workers were
      // draining -- this one is already obsolete.
      throw new RegexSearchCancelledError("superseded by a newer search");
    }

    const run = new RegexSearchRun(
      { rows: request.rows, spec: request.spec, limit: request.limit },
      this.budgetMs,
      this.spawn,
      (finished) => this.onRunFinished(finished)
    );
    this.current = run;
    run.start();
    return run.done;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelCurrent(
      new RegexSearchCancelledError("regex search pool is disposed")
    );
    await this.drainTerminations();
  }

  private cancelCurrent(reason: Error): void {
    const previous = this.current;
    this.current = undefined;
    previous?.cancel(reason);
  }

  // Called for every run that started (or tried to start) a worker,
  // whatever ended it -- success, timeout, worker failure, or
  // supersession. Registers the worker-termination promise so both the
  // spawn barrier and dispose() wait for the thread to actually exit.
  private onRunFinished(run: RegexSearchRun): void {
    if (this.current === run) {
      this.current = undefined;
    }
    const termination = run.whenTerminated();
    this.pendingTerminations.add(termination);
    void termination
      .catch(() => undefined)
      .finally(() => this.pendingTerminations.delete(termination));
  }

  private async drainTerminations(): Promise<void> {
    while (this.pendingTerminations.size > 0) {
      await Promise.allSettled([...this.pendingTerminations]);
    }
  }
}
