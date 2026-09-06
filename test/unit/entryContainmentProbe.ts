import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { scanContainedMarkdownFiles } from "../../src/entryContainment";

// Standalone probe for entryContainmentProbe.test.ts. It builds an
// entries tree seeded with directory-junction cycles (a link back to an
// ancestor, and a link to an outside-root directory that itself contains
// Markdown) and runs the production scan. If a regression makes the scan
// follow links, this recurses until the stack or the disk gives out; the
// parent test forks this process and enforces an outer SIGKILL deadline,
// so the regression shows up as a killed process rather than a wedged
// Mocha runner. A same-thread timeout could not interrupt unbounded
// synchronous-style recursion here.
//
// Compiled (test tsconfig includes test/unit/**) but not named *.test.js,
// so Mocha never loads it as a suite.

async function buildTree(): Promise<{ root: string; entries: string }> {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "vs-journal-containment-probe-")
  );
  const entries = path.join(root, "blog", "entries");
  await fs.ensureDir(path.join(entries, "2026", "07", "24"));
  await fs.writeFile(
    path.join(entries, "2026", "07", "24", "real.md"),
    "---\ntitle: Real\ndate: 2026-07-24 09:00:00\ntags: []\n---\n\nbody\n"
  );

  // Cycle 1: entries/2026/loop -> entries  (direct ancestor loop)
  await fs.symlink(entries, path.join(entries, "2026", "loop"), "junction");

  // Cycle 2: a deeper ladder that loops back on itself.
  const ladder = path.join(entries, "a", "b", "c");
  await fs.ensureDir(ladder);
  await fs.symlink(path.join(entries, "a"), path.join(ladder, "up"), "junction");

  // Outside-root junction that DOES contain Markdown -- must not be
  // traversed or indexed.
  const outside = path.join(root, "outside");
  await fs.ensureDir(path.join(outside, "deep"));
  await fs.writeFile(path.join(outside, "leak.md"), "leak");
  await fs.writeFile(path.join(outside, "deep", "leak2.md"), "leak");
  await fs.symlink(outside, path.join(entries, "linked"), "junction");

  return { root, entries };
}

async function main(): Promise<void> {
  let root: string | undefined;
  try {
    const tree = await buildTree();
    root = tree.root;
    const found = await scanContainedMarkdownFiles(tree.entries, root, [
      ".vs-journal",
    ]);
    const rels = found.map((file) => file.relativePath).sort();
    const ok = rels.length === 1 && rels[0] === "2026/07/24/real.md";
    process.stdout.write(
      `${JSON.stringify({ allOk: ok, scanned: rels })}\n`
    );
    process.exit(ok ? 0 : 1);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ allOk: false, crash: String(error) })}\n`
    );
    process.exit(2);
  } finally {
    if (root) {
      await fs.remove(root).catch(() => undefined);
    }
  }
}

void main();
