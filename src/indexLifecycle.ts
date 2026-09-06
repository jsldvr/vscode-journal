// Generation-owned lifecycle for the journal's on-disk index.
//
// The configured journal directory can change (a `vsJournal.blogPath`
// edit) or go away (deactivation) while an `open()` for the previous
// directory is still awaiting filesystem and database work. Without an
// ownership check the late `open()` publishes its result and the host
// serves directory A's index under configuration B.
//
// This type enforces the invariants:
//   - Only the current generation's open may publish its result as the
//     active index; a superseded open never becomes current and never
//     clears a newer pending open.
//   - Every index successfully opened for a superseded generation is
//     closed.
//   - Callers sharing a generation share the one in-flight open.
//   - A failed open (or an unresolvable target) leaves the host able to
//     retry with no stale pending state cached.
//   - Disposal is terminal and idempotent: it awaits every open still in
//     flight -- including ones already superseded -- and every owned
//     close, and no later `ensure()` can start another open or resurrect
//     index state.
//
// It is deliberately free of `vscode` imports so the lifecycle logic can
// be exercised directly by the unit suite with deferred fakes.

export interface IndexLifecycleDeps<TIndex> {
  // Snapshot the target directory for the current configuration, or
  // undefined when nothing valid is configured (no workspace, or a path
  // outside it). Read fresh on every open attempt.
  resolveTarget(): string | undefined;

  // Open an index for a resolved target. `createTargetDir` carries New
  // Entry's escalation: when false and the blog directory is absent the
  // implementation resolves undefined (passive startup must not scaffold
  // directories); when true it creates what it needs. Implementations
  // report their own errors and resolve undefined on failure so the host
  // can retry later.
  open(target: string, createTargetDir: boolean): Promise<TIndex | undefined>;

  // Close an index previously produced by `open()`. Must tolerate being
  // called for an index that was never published as current.
  close(index: TIndex): Promise<void>;
}

interface PendingOpen<TIndex> {
  readonly generation: number;
  readonly createTargetDir: boolean;
  // Assigned synchronously by startOpen() immediately after `this.pending`
  // is set, so runOpen()'s completion can disown it by identity.
  promise: Promise<TIndex | undefined>;
}

// Resolve to the value, or to undefined on rejection. Every consumer of
// a pending-open or cleanup promise routes through this so a rejected
// open can never surface as an unhandled rejection or abort a waiter.
function settle<T>(promise: Promise<T>): Promise<T | undefined> {
  return promise.then(
    (value) => value,
    () => undefined
  );
}

export class IndexLifecycle<TIndex> {
  private generation = 0;
  private current: TIndex | undefined;
  private currentGeneration = -1;
  private pending: PendingOpen<TIndex> | undefined;
  private disposed = false;
  private disposal: Promise<void> | undefined;
  // Every open still running, keyed by a self-removing wrapper. Includes
  // opens invalidate() has already disowned as current -- disposal still
  // has to wait for them to finish and self-close.
  private readonly inFlight = new Set<Promise<unknown>>();
  // Closes owned by the host: retired-index closes from invalidate(),
  // superseded-open self-closes, and the active-index close at disposal.
  private readonly cleanups = new Set<Promise<unknown>>();

  constructor(private readonly deps: IndexLifecycleDeps<TIndex>) {}

  // The active index, or undefined when none is open. Never a superseded
  // one: a retired index is cleared here the moment it is retired.
  get(): TIndex | undefined {
    return this.current;
  }

  isDisposed(): boolean {
    return this.disposed;
  }

  // Generation that owns the published index, or -1 when none. Exposed
  // for lifecycle assertions.
  activeGeneration(): number {
    return this.currentGeneration;
  }

  // Return the current index, opening it on demand. Concurrent callers
  // in the same generation share one open. `createTargetDir` escalates a
  // passive open that is already in flight.
  async ensure(createTargetDir = false): Promise<TIndex | undefined> {
    if (this.disposed) {
      return undefined;
    }
    if (this.current) {
      return this.current;
    }
    if (this.pending && createTargetDir && !this.pending.createTargetDir) {
      // A passive open in flight cannot satisfy a caller that needs the
      // directory created; wait it out, then retry with creation on.
      await settle(this.pending.promise);
      return this.ensure(createTargetDir);
    }
    if (!this.pending) {
      this.startOpen(createTargetDir);
    }
    const pending = this.pending;
    if (pending) {
      await settle(pending.promise);
    }
    if (this.disposed) {
      return undefined;
    }
    return this.current;
  }

  // Claims pending ownership synchronously, then starts the work, so a
  // synchronously-settling attempt (an unresolvable target) can never
  // leave a stale pending open cached. An unresolvable target claims
  // nothing: ensure() falls through to the (absent) current index and a
  // later call retries from scratch.
  private startOpen(createTargetDir: boolean): void {
    const target = this.deps.resolveTarget();
    if (target === undefined) {
      return;
    }
    const generation = this.generation;
    const pending: PendingOpen<TIndex> = {
      generation,
      createTargetDir,
      promise: Promise.resolve<TIndex | undefined>(undefined),
    };
    this.pending = pending;
    pending.promise = this.runOpen(pending, generation, target, createTargetDir);
    this.retain(this.inFlight, pending.promise);
  }

  private async runOpen(
    pending: PendingOpen<TIndex>,
    generation: number,
    target: string,
    createTargetDir: boolean
  ): Promise<TIndex | undefined> {
    let opened: TIndex | undefined;
    try {
      opened = await this.deps.open(target, createTargetDir);
    } catch {
      opened = undefined;
    } finally {
      if (this.pending === pending) {
        this.pending = undefined;
      }
    }
    if (opened === undefined) {
      return undefined;
    }
    if (!this.isCurrentGeneration(generation)) {
      // Superseded or disposed while opening: close what we opened and
      // never publish it.
      this.retain(this.cleanups, this.deps.close(opened));
      return undefined;
    }
    this.current = opened;
    this.currentGeneration = generation;
    return opened;
  }

  // The single decision that lets an in-flight open publish its result.
  // `protected` so the unit suite can subclass and model the pre-fix
  // behavior (always publish) to prove the regression is caught.
  protected isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.generation;
  }

  // Retire the current index and disown any in-flight open. The next
  // `ensure()` starts a fresh open for whatever the configuration now
  // resolves to. A disowned open stays tracked in `inFlight` so disposal
  // still waits for it.
  invalidate(): Promise<void> {
    if (this.disposed) {
      return this.disposal ?? Promise.resolve();
    }
    this.generation++;
    this.pending = undefined;
    const previous = this.current;
    this.current = undefined;
    this.currentGeneration = -1;
    if (!previous) {
      return Promise.resolve();
    }
    const closed = this.deps.close(previous);
    this.retain(this.cleanups, closed);
    return settle(closed).then(() => undefined);
  }

  // Terminal and idempotent. Awaits every open still in flight (each
  // self-closes when it resolves for a disposed host) and every owned
  // close, then refuses all further work.
  dispose(): Promise<void> {
    if (this.disposal) {
      return this.disposal;
    }
    this.disposed = true;
    this.generation++;
    this.disposal = this.runDispose();
    return this.disposal;
  }

  private async runDispose(): Promise<void> {
    this.pending = undefined;
    await this.drain(this.inFlight);
    const previous = this.current;
    this.current = undefined;
    this.currentGeneration = -1;
    if (previous) {
      this.retain(this.cleanups, this.deps.close(previous));
    }
    await this.drain(this.cleanups);
  }

  private retain(set: Set<Promise<unknown>>, work: Promise<unknown>): void {
    const tracked = settle(work).then(() => {
      set.delete(tracked);
    });
    set.add(tracked);
  }

  private async drain(set: Set<Promise<unknown>>): Promise<void> {
    while (set.size > 0) {
      await Promise.all([...set]);
    }
  }
}
