import { IndexLifecycle } from "../../src/indexLifecycle";

// Standalone probe for indexLifecycleProbe.test.ts. It drives the
// lifecycle scenario that spins the microtask queue forever against a
// regressed implementation: an unresolvable target must not leave a
// stale pending open cached, or a following ensure(true) recurses
// through the escalation branch without end and starves the event loop.
// The parent test forks this process and enforces an outer SIGKILL
// deadline, so a regression shows up as a killed process rather than a
// wedged Mocha runner -- a same-thread timeout could not interrupt the
// loop.
//
// This file is compiled (the test tsconfig includes test/unit/**) but is
// not named *.test.js, so Mocha never picks it up as a suite.

interface FakeIndex {
  readonly id: string;
}

// Passive ensure() against an unresolvable target, then -- once a target
// exists -- ensure(true). Must create the directory and return the new
// index in bounded time.
async function ensureTrueAfterUnresolvablePassiveOpen(): Promise<
  Record<string, unknown>
> {
  let target: string | undefined;
  const openedWith: string[] = [];
  const life = new IndexLifecycle<FakeIndex>({
    resolveTarget: () => target,
    open: async (resolvedTarget, createTargetDir) => {
      openedWith.push(`${resolvedTarget}:${createTargetDir}`);
      return { id: resolvedTarget };
    },
    close: async () => undefined,
  });

  const passive = await life.ensure(false);
  if (passive !== undefined) {
    return { ok: false, reason: "passive open resolved with an index" };
  }

  target = "A";
  const created = await life.ensure(true);
  return {
    ok:
      created?.id === "A" &&
      openedWith.length === 1 &&
      openedWith[0] === "A:true",
    created: created?.id,
    openedWith,
  };
}

async function main(): Promise<void> {
  const report: Record<string, unknown> = {};
  report.ensureTrueAfterUnresolvable =
    await ensureTrueAfterUnresolvablePassiveOpen();

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
