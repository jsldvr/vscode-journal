import * as assert from "assert";
import {
  IndexLifecycle,
  IndexLifecycleDeps,
} from "../../src/indexLifecycle";

interface FakeIndex {
  readonly id: string;
}

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
}

function defer<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drains the microtask queue so continuations awaited inside the
// lifecycle run before the test asserts. No wall-clock waiting, no
// timing races.
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface OpenCall {
  readonly target: string;
  readonly createTargetDir: boolean;
  readonly gate: Deferred<FakeIndex | undefined>;
}

// Deferred fakes for open()/close() around the real IndexLifecycle. Each
// open() parks on a gate the test resolves explicitly; close() records
// the index id and can be gated too.
class Harness {
  target: string | undefined = "A";
  readonly openCalls: OpenCall[] = [];
  readonly closed: string[] = [];
  private readonly closeGates = new Map<string, Deferred<void>>();

  deps(): IndexLifecycleDeps<FakeIndex> {
    return {
      resolveTarget: () => this.target,
      open: (target, createTargetDir) => {
        const call: OpenCall = {
          target,
          createTargetDir,
          gate: defer<FakeIndex | undefined>(),
        };
        this.openCalls.push(call);
        return call.gate.promise;
      },
      close: (index) => {
        this.closed.push(index.id);
        const gate = this.closeGates.get(index.id);
        return gate ? gate.promise : Promise.resolve();
      },
    };
  }

  blockClose(id: string): void {
    this.closeGates.set(id, defer<void>());
  }

  releaseClose(id: string): void {
    this.closeGates.get(id)?.resolve();
  }
}

// Models the pre-fix behavior: an in-flight open always publishes its
// result, with no generation ownership check. The regression tests below
// assert the real lifecycle's outcome; this subclass is used once to
// show that same assertion fails against the former behavior.
class LegacyLifecycle<TIndex> extends IndexLifecycle<TIndex> {
  protected isCurrentGeneration(): boolean {
    return true;
  }
}

suite("IndexLifecycle", () => {
  test("a superseded startup open never becomes current and is closed", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const ensureA = life.ensure();
    await flush();
    h.target = "B";
    await life.invalidate();
    const ensureB = life.ensure();
    await flush();

    assert.strictEqual(h.openCalls.length, 2);
    const bIndex: FakeIndex = { id: "B" };
    h.openCalls[1].gate.resolve(bIndex);
    await ensureB;

    // A's open resolves late, after configuration has moved to B.
    const aIndex: FakeIndex = { id: "A" };
    h.openCalls[0].gate.resolve(aIndex);
    await ensureA;
    await flush();

    assert.strictEqual(life.get(), bIndex, "current index must be B");
    assert.strictEqual(life.activeGeneration(), 1);
    assert.deepStrictEqual(h.closed, ["A"], "the late A open must be closed");
  });

  test("regression: the former lifecycle behavior fails the same scenario", async () => {
    const h = new Harness();
    const life = new LegacyLifecycle<FakeIndex>(h.deps());

    const ensureA = life.ensure();
    await flush();
    h.target = "B";
    await life.invalidate();
    const ensureB = life.ensure();
    await flush();

    const bIndex: FakeIndex = { id: "B" };
    h.openCalls[1].gate.resolve(bIndex);
    await ensureB;
    const aIndex: FakeIndex = { id: "A" };
    h.openCalls[0].gate.resolve(aIndex);
    await ensureA;
    await flush();

    // The defect: the late A open overwrites B and is never closed.
    assert.strictEqual(life.get(), aIndex);
    assert.deepStrictEqual(h.closed, []);
  });

  test("rapid A/B/C changes: only the last generation publishes; earlier opens close", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const eA = life.ensure();
    await flush();
    h.target = "B";
    await life.invalidate();
    const eB = life.ensure();
    await flush();
    h.target = "C";
    await life.invalidate();
    const eC = life.ensure();
    await flush();

    assert.strictEqual(h.openCalls.length, 3);
    // Resolve out of submission order: A (obsolete), then C (current),
    // then B (obsolete).
    h.openCalls[0].gate.resolve({ id: "A" });
    const cIndex: FakeIndex = { id: "C" };
    h.openCalls[2].gate.resolve(cIndex);
    h.openCalls[1].gate.resolve({ id: "B" });
    await Promise.all([eA, eB, eC]);
    await flush();

    assert.strictEqual(life.get(), cIndex);
    assert.strictEqual(life.activeGeneration(), 2);
    assert.deepStrictEqual(h.closed, ["A", "B"]);
  });

  test("concurrent same-generation ensure calls share one open", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const e1 = life.ensure();
    const e2 = life.ensure();
    const e3 = life.ensure(false);
    await flush();

    assert.strictEqual(h.openCalls.length, 1);
    const idx: FakeIndex = { id: "A" };
    h.openCalls[0].gate.resolve(idx);
    const [r1, r2, r3] = await Promise.all([e1, e2, e3]);

    assert.strictEqual(r1, idx);
    assert.strictEqual(r2, idx);
    assert.strictEqual(r3, idx);
    assert.strictEqual(life.get(), idx);
  });

  test("a failed open leaves the host able to retry", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const e1 = life.ensure();
    await flush();
    h.openCalls[0].gate.resolve(undefined);
    assert.strictEqual(await e1, undefined);
    assert.strictEqual(life.get(), undefined);

    const e2 = life.ensure();
    await flush();
    assert.strictEqual(h.openCalls.length, 2, "retry starts a fresh open");
    const idx: FakeIndex = { id: "A" };
    h.openCalls[1].gate.resolve(idx);
    assert.strictEqual(await e2, idx);
    assert.strictEqual(life.get(), idx);
  });

  test("a rejected open is contained and retryable", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const e1 = life.ensure();
    await flush();
    h.openCalls[0].gate.reject(new Error("database locked"));
    assert.strictEqual(await e1, undefined);
    assert.strictEqual(life.get(), undefined);

    const e2 = life.ensure();
    await flush();
    const idx: FakeIndex = { id: "A" };
    h.openCalls[1].gate.resolve(idx);
    assert.strictEqual(await e2, idx);
  });

  test("passive open followed by ensure(true) escalates to create the directory", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const passive = life.ensure(false);
    await flush();
    assert.strictEqual(h.openCalls[0].createTargetDir, false);
    h.openCalls[0].gate.resolve(undefined);
    assert.strictEqual(await passive, undefined);

    const created = life.ensure(true);
    await flush();
    assert.strictEqual(h.openCalls.length, 2);
    assert.strictEqual(h.openCalls[1].createTargetDir, true);
    const idx: FakeIndex = { id: "A" };
    h.openCalls[1].gate.resolve(idx);
    assert.strictEqual(await created, idx);
  });

  test("ensure(true) escalates a passive open that is still in flight", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const passive = life.ensure(false);
    await flush();
    const escalated = life.ensure(true);
    await flush();

    assert.strictEqual(h.openCalls.length, 1, "escalation waits for the passive open");
    h.openCalls[0].gate.resolve(undefined);
    assert.strictEqual(await passive, undefined);
    await flush();

    assert.strictEqual(h.openCalls.length, 2);
    assert.strictEqual(h.openCalls[1].createTargetDir, true);
    const idx: FakeIndex = { id: "A" };
    h.openCalls[1].gate.resolve(idx);
    assert.strictEqual(await escalated, idx);
    assert.strictEqual(life.get(), idx);
  });

  test("disposal during an in-flight open closes the opened index and refuses later ensure", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const e1 = life.ensure();
    await flush();
    const disposed = life.dispose();
    await flush();

    h.openCalls[0].gate.resolve({ id: "A" });
    await disposed;

    assert.strictEqual(await e1, undefined);
    assert.strictEqual(life.get(), undefined);
    assert.strictEqual(life.isDisposed(), true);
    assert.deepStrictEqual(
      h.closed,
      ["A"],
      "an index opened during disposal is closed"
    );

    const late = await life.ensure();
    assert.strictEqual(late, undefined);
    assert.strictEqual(h.openCalls.length, 1, "no open is started after disposal");
  });

  test("disposal while a close is in flight awaits that close", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const e1 = life.ensure();
    await flush();
    const idx: FakeIndex = { id: "A" };
    h.openCalls[0].gate.resolve(idx);
    await e1;
    assert.strictEqual(life.get(), idx);

    h.blockClose("A");
    const invalidated = life.invalidate();
    await flush();

    let disposeResolved = false;
    const disposed = life.dispose().then(() => {
      disposeResolved = true;
    });
    await flush();
    assert.strictEqual(
      disposeResolved,
      false,
      "dispose must wait for the in-flight close"
    );

    h.releaseClose("A");
    await invalidated;
    await disposed;

    assert.strictEqual(disposeResolved, true);
    assert.deepStrictEqual(h.closed, ["A"], "A is closed exactly once");
    assert.strictEqual(life.isDisposed(), true);
  });

  test("repeated disposal is idempotent", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const e1 = life.ensure();
    await flush();
    h.openCalls[0].gate.resolve({ id: "A" });
    await e1;

    const d1 = life.dispose();
    const d2 = life.dispose();
    assert.strictEqual(d1, d2, "same disposal promise is returned");
    await Promise.all([d1, d2]);
    assert.deepStrictEqual(h.closed, ["A"], "closed once despite repeated dispose");

    await life.dispose();
    assert.deepStrictEqual(h.closed, ["A"]);
  });

  test("invalidate after disposal cannot reopen or resurrect state", async () => {
    const h = new Harness();
    const life = new IndexLifecycle<FakeIndex>(h.deps());

    const e1 = life.ensure();
    await flush();
    h.openCalls[0].gate.resolve({ id: "A" });
    await e1;
    await life.dispose();

    await life.invalidate();
    assert.strictEqual(life.get(), undefined);
    assert.strictEqual(await life.ensure(true), undefined);
    assert.strictEqual(h.openCalls.length, 1, "no open after disposal");
  });
});
