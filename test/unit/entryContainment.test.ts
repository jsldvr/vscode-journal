import * as assert from "assert";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  EntryContainmentError,
  assertGeneratedFileMovable,
  assertSafeExistingDirectory,
  assertSafeExistingFile,
  assertSafeGeneratedState,
  createSafeContainedDirectory,
  resolveSafeExistingEntryFile,
  scanContainedMarkdownFiles,
  verifyContainedRealDirectoryChain,
} from "../../src/entryContainment";

// Windows creates directory junctions without privilege but gates file
// symlinks behind Developer Mode / elevation. Every test that needs a
// link attempts to create it and skips itself (rather than failing CI)
// when the platform refuses -- except the directory-junction cases,
// which are the mandatory cross-platform containment coverage.
async function tryDirLink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

async function tryFileLink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-containment-"));
}

async function writeFileDeep(file: string, content = "x"): Promise<void> {
  await fs.ensureDir(path.dirname(file));
  await fs.writeFile(file, content);
}

suite("entryContainment", function () {
  this.timeout(20000);

  let root: string;

  setup(async () => {
    root = await makeTempDir();
  });

  teardown(async () => {
    await fs.remove(root).catch(() => undefined);
  });

  // -- verifyContainedRealDirectoryChain ---------------------------------

  test("accepts a fully real nested directory chain", async () => {
    const entries = path.join(root, "blog", "entries", "2026", "07", "24");
    await fs.ensureDir(entries);
    const result = await verifyContainedRealDirectoryChain(
      root,
      entries,
      "unsafe-root"
    );
    assert.strictEqual(result.status, "ok");
  });

  test("rejects a target outside the trust anchor", async () => {
    await assert.rejects(
      () =>
        verifyContainedRealDirectoryChain(
          path.join(root, "inside"),
          path.join(root, "outside"),
          "unsafe-root"
        ),
      (error: unknown) =>
        error instanceof EntryContainmentError && error.kind === "unsafe-root"
    );
  });

  test("throws on a missing tail unless explicitly allowed", async () => {
    const target = path.join(root, "blog", "entries");
    await fs.ensureDir(path.join(root, "blog"));
    await assert.rejects(
      () => verifyContainedRealDirectoryChain(root, target, "unsafe-root"),
      (error: unknown) => error instanceof EntryContainmentError
    );
    const relaxed = await verifyContainedRealDirectoryChain(
      root,
      target,
      "unsafe-root",
      { allowMissingTail: true }
    );
    assert.strictEqual(relaxed.status, "missing");
    assert.strictEqual(relaxed.firstMissing, target);
  });

  test("rejects a chain that runs through a directory junction", async () => {
    const outside = path.join(root, "outside");
    await fs.ensureDir(outside);
    const linked = path.join(root, "blog", "entries");
    await fs.ensureDir(path.dirname(linked));
    assert.ok(
      await tryDirLink(outside, linked),
      "directory junctions must be creatable for the mandatory containment test"
    );
    await assert.rejects(
      () =>
        verifyContainedRealDirectoryChain(
          root,
          path.join(linked, "2026"),
          "unsafe-root"
        ),
      (error: unknown) =>
        error instanceof EntryContainmentError && error.kind === "unsafe-root"
    );
  });

  // -- assertSafeExistingFile / assertSafeExistingDirectory -------------

  test("assertSafeExistingFile accepts a real regular file and rejects a directory", async () => {
    const file = path.join(root, "entries", "2026", "note.md");
    await writeFileDeep(file);
    await assertSafeExistingFile(root, file, "unsafe-entry");
    await assert.rejects(
      () =>
        assertSafeExistingFile(
          root,
          path.join(root, "entries", "2026"),
          "unsafe-entry"
        ),
      (error: unknown) => error instanceof EntryContainmentError
    );
  });

  test("assertSafeExistingFile rejects a file reached through a junction ancestor", async () => {
    const outside = path.join(root, "outside");
    await writeFileDeep(path.join(outside, "note.md"));
    const linkedDir = path.join(root, "entries", "linked");
    await fs.ensureDir(path.dirname(linkedDir));
    assert.ok(await tryDirLink(outside, linkedDir));
    await assert.rejects(
      () =>
        assertSafeExistingFile(
          root,
          path.join(linkedDir, "note.md"),
          "unsafe-entry"
        ),
      (error: unknown) =>
        error instanceof EntryContainmentError && error.kind === "unsafe-entry"
    );
  });

  test("assertSafeExistingFile rejects a symlinked final file where file links are supported", async () => {
    const realTarget = path.join(root, "outside.md");
    await fs.writeFile(realTarget, "x");
    const link = path.join(root, "entries", "2026", "linked.md");
    await fs.ensureDir(path.dirname(link));
    if (!(await tryFileLink(realTarget, link))) {
      return; // No file-symlink privilege on this platform.
    }
    await assert.rejects(
      () => assertSafeExistingFile(root, link, "unsafe-entry"),
      (error: unknown) => error instanceof EntryContainmentError
    );
  });

  test("assertSafeExistingDirectory rejects a missing directory", async () => {
    await assert.rejects(
      () =>
        assertSafeExistingDirectory(
          root,
          path.join(root, "entries", "nope"),
          "unsafe-entry"
        ),
      (error: unknown) => error instanceof EntryContainmentError
    );
  });

  // -- resolveSafeExistingEntryFile ------------------------------------

  test("resolves a real nested entry and rejects escapes without throwing", async () => {
    const entries = path.join(root, "entries");
    const rel = path.join("2026", "07", "24", "hello.md");
    await writeFileDeep(path.join(entries, rel));

    assert.strictEqual(
      await resolveSafeExistingEntryFile(entries, rel),
      path.join(entries, rel)
    );
    assert.strictEqual(
      await resolveSafeExistingEntryFile(entries, "../../evil.md"),
      undefined
    );
    assert.strictEqual(
      await resolveSafeExistingEntryFile(entries, path.join(root, "abs.md")),
      undefined
    );
    assert.strictEqual(
      await resolveSafeExistingEntryFile(entries, "missing.md"),
      undefined
    );
    assert.strictEqual(await resolveSafeExistingEntryFile(entries, ""), undefined);
  });

  test("resolveSafeExistingEntryFile rejects a path through a junction component", async () => {
    const entries = path.join(root, "entries");
    await fs.ensureDir(entries);
    const outside = path.join(root, "outside");
    await writeFileDeep(path.join(outside, "note.md"));
    assert.ok(await tryDirLink(outside, path.join(entries, "linked")));
    assert.strictEqual(
      await resolveSafeExistingEntryFile(
        entries,
        path.join("linked", "note.md")
      ),
      undefined
    );
  });

  // -- createSafeContainedDirectory ----------------------------------

  test("creates a missing safe nested chain and is idempotent", async () => {
    const target = path.join(root, "blog", "entries", "2026", "07");
    await createSafeContainedDirectory(root, target, "unsafe-root");
    const stat = await fs.lstat(target);
    assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
    // Second call must not throw.
    await createSafeContainedDirectory(root, target, "unsafe-root");
  });

  test("refuses to create below an existing junction ancestor", async () => {
    const outside = path.join(root, "outside");
    await fs.ensureDir(outside);
    const linked = path.join(root, "blog");
    assert.ok(await tryDirLink(outside, linked));
    await assert.rejects(
      () =>
        createSafeContainedDirectory(
          root,
          path.join(linked, "entries", "2026"),
          "unsafe-root"
        ),
      (error: unknown) =>
        error instanceof EntryContainmentError && error.kind === "unsafe-root"
    );
    // The junction target must not have been written into.
    assert.strictEqual(await fs.pathExists(path.join(outside, "entries")), false);
  });

  // -- scanContainedMarkdownFiles ----------------------------------

  test("scans real nested Markdown, skips the generated dir, ignores non-md", async () => {
    const entries = path.join(root, "entries");
    await writeFileDeep(path.join(entries, "2026", "07", "24", "a.md"));
    await writeFileDeep(path.join(entries, "2026", "07", "b.md"));
    await writeFileDeep(path.join(entries, "notes.txt"));
    await writeFileDeep(path.join(entries, ".vs-journal", "index.sqlite3"));
    await writeFileDeep(path.join(entries, ".vs-journal", "shadow.md"));

    const found = await scanContainedMarkdownFiles(entries, root, [
      ".vs-journal",
    ]);
    const rels = found.map((f) => f.relativePath).sort();
    assert.deepStrictEqual(rels, ["2026/07/24/a.md", "2026/07/b.md"]);
  });

  test("returns [] for a missing entries dir and throws for a junctioned one", async () => {
    const entries = path.join(root, "entries");
    assert.deepStrictEqual(
      await scanContainedMarkdownFiles(entries, root, [".vs-journal"]),
      []
    );

    const outside = path.join(root, "outside");
    await writeFileDeep(path.join(outside, "leak.md"));
    assert.ok(await tryDirLink(outside, entries));
    await assert.rejects(
      () => scanContainedMarkdownFiles(entries, root, [".vs-journal"]),
      (error: unknown) => error instanceof EntryContainmentError
    );
  });

  test("does not traverse an outside-root directory junction placed under entries", async () => {
    const entries = path.join(root, "entries");
    await writeFileDeep(path.join(entries, "2026", "real.md"));
    const outside = path.join(root, "outside");
    await writeFileDeep(path.join(outside, "leak.md"));
    await writeFileDeep(path.join(outside, "deep", "leak2.md"));
    assert.ok(await tryDirLink(outside, path.join(entries, "2026", "linked")));

    const found = await scanContainedMarkdownFiles(entries, root, [
      ".vs-journal",
    ]);
    assert.deepStrictEqual(
      found.map((f) => f.relativePath),
      ["2026/real.md"]
    );
  });

  test("does not index a symlinked Markdown file where file links are supported", async () => {
    const entries = path.join(root, "entries");
    await writeFileDeep(path.join(entries, "2026", "real.md"));
    const realTarget = path.join(root, "target.md");
    await fs.writeFile(realTarget, "x");
    if (!(await tryFileLink(realTarget, path.join(entries, "2026", "link.md")))) {
      return;
    }
    const found = await scanContainedMarkdownFiles(entries, root, [
      ".vs-journal",
    ]);
    assert.deepStrictEqual(
      found.map((f) => f.relativePath),
      ["2026/real.md"]
    );
  });

  test("a junction cycle back to an ancestor terminates without recursing", async () => {
    const entries = path.join(root, "entries");
    await writeFileDeep(path.join(entries, "2026", "real.md"));
    // entries/2026/loop -> entries  (a cycle if followed)
    assert.ok(await tryDirLink(entries, path.join(entries, "2026", "loop")));
    const found = await scanContainedMarkdownFiles(entries, root, [
      ".vs-journal",
    ]);
    assert.deepStrictEqual(
      found.map((f) => f.relativePath),
      ["2026/real.md"]
    );
  });

  // -- generated-state guards -------------------------------------

  test("assertSafeGeneratedState accepts a real tree and missing db files", async () => {
    const entries = path.join(root, "entries");
    const generated = path.join(entries, ".vs-journal");
    await fs.ensureDir(generated);
    await assertSafeGeneratedState(
      root,
      entries,
      generated,
      path.join(generated, "index.sqlite3")
    );
  });

  test("assertSafeGeneratedState rejects a junctioned .vs-journal", async () => {
    const entries = path.join(root, "entries");
    await fs.ensureDir(entries);
    const outside = path.join(root, "outside");
    await fs.ensureDir(outside);
    const generated = path.join(entries, ".vs-journal");
    assert.ok(await tryDirLink(outside, generated));
    await assert.rejects(
      () =>
        assertSafeGeneratedState(
          root,
          entries,
          generated,
          path.join(generated, "index.sqlite3")
        ),
      (error: unknown) =>
        error instanceof EntryContainmentError &&
        error.kind === "unsafe-generated"
    );
  });

  test("assertSafeGeneratedState rejects a symlinked database file (fs fake for the link)", async () => {
    const entries = path.join(root, "entries");
    const generated = path.join(entries, ".vs-journal");
    await fs.ensureDir(generated);
    const dbPath = path.join(generated, "index.sqlite3");

    const fsExtraModule = require("fs-extra");
    const originalLstat = fsExtraModule.lstat;
    fsExtraModule.lstat = async (target: string) => {
      if (target === dbPath) {
        return {
          isSymbolicLink: () => true,
          isFile: () => false,
          isDirectory: () => false,
        };
      }
      return originalLstat(target);
    };
    try {
      await assert.rejects(
        () => assertSafeGeneratedState(root, entries, generated, dbPath),
        (error: unknown) =>
          error instanceof EntryContainmentError &&
          error.kind === "unsafe-generated"
      );
    } finally {
      fsExtraModule.lstat = originalLstat;
    }
  });

  test("assertGeneratedFileMovable reports missing, safe, and rejects a link", async () => {
    const generated = path.join(root, "entries", ".vs-journal");
    await fs.ensureDir(generated);
    const file = path.join(generated, "index.sqlite3");
    assert.strictEqual(
      await assertGeneratedFileMovable(root, generated, file),
      "missing"
    );
    await fs.writeFile(file, "x");
    assert.strictEqual(
      await assertGeneratedFileMovable(root, generated, file),
      "safe"
    );

    const linkTarget = path.join(root, "elsewhere.sqlite3");
    await fs.writeFile(linkTarget, "x");
    const link = path.join(generated, "linked.sqlite3");
    if (await tryFileLink(linkTarget, link)) {
      await assert.rejects(
        () => assertGeneratedFileMovable(root, generated, link),
        (error: unknown) =>
          error instanceof EntryContainmentError &&
          error.kind === "unsafe-generated"
      );
    }
  });

  test("assertGeneratedFileMovable revalidates the .vs-journal parent chain, not just the final file (stale-parent regression)", async () => {
    const generated = path.join(root, "entries", ".vs-journal");
    await fs.ensureDir(generated);
    const file = path.join(generated, "index.sqlite3");
    await fs.writeFile(file, "x");

    // The final file is a genuine regular file; only its .vs-journal
    // parent reports as a link. A guard that trusted an earlier parent
    // check and lstat-ed only the final name would move/delete through
    // the junction; the parent-chain revalidation must reject it.
    const fsExtraModule = require("fs-extra");
    const originalLstat = fsExtraModule.lstat;
    fsExtraModule.lstat = async (target: string) => {
      if (path.resolve(target) === path.resolve(generated)) {
        return {
          isSymbolicLink: () => true,
          isFile: () => false,
          isDirectory: () => false,
        };
      }
      return originalLstat(target);
    };
    try {
      await assert.rejects(
        () => assertGeneratedFileMovable(root, generated, file),
        (error: unknown) =>
          error instanceof EntryContainmentError &&
          error.kind === "unsafe-generated"
      );
    } finally {
      fsExtraModule.lstat = originalLstat;
    }
  });

  test("assertSafeGeneratedState rejects a .vs-journal swapped to a link after its own directory check (open-boundary regression)", async () => {
    const entries = path.join(root, "entries");
    const generated = path.join(entries, ".vs-journal");
    await fs.ensureDir(generated);
    const dbPath = path.join(generated, "index.sqlite3");

    const fsExtraModule = require("fs-extra");
    const originalLstat = fsExtraModule.lstat;
    let generatedLstatCalls = 0;
    fsExtraModule.lstat = async (target: string) => {
      if (path.resolve(target) === path.resolve(generated)) {
        generatedLstatCalls += 1;
        if (generatedLstatCalls > 1) {
          return {
            isSymbolicLink: () => true,
            isFile: () => false,
            isDirectory: () => false,
          };
        }
      }
      return originalLstat(target);
    };
    try {
      await assert.rejects(
        () => assertSafeGeneratedState(root, entries, generated, dbPath),
        (error: unknown) =>
          error instanceof EntryContainmentError &&
          error.kind === "unsafe-generated"
      );
    } finally {
      fsExtraModule.lstat = originalLstat;
    }
  });

  test("scan does not follow a directory swapped to a junction between enumeration and descent (stale-Dirent regression)", async () => {
    const entries = path.join(root, "entries");
    await writeFileDeep(path.join(entries, "2026", "real.md"));
    const swapDir = path.join(entries, "2026", "victim");
    await fs.ensureDir(swapDir);
    await writeFileDeep(path.join(swapDir, "inner.md"));

    const outside = path.join(root, "outside");
    await writeFileDeep(path.join(outside, "leak.md"));
    await writeFileDeep(path.join(outside, "deep", "leak2.md"));

    // After the parent directory is enumerated, replace `victim` with a
    // junction to an outside tree before the scan descends into it.
    const fsExtraModule = require("fs-extra");
    const originalReaddir = fsExtraModule.readdir;
    const originalRemove = fsExtraModule.remove;
    let swapped = false;
    fsExtraModule.readdir = async (dir: string, options?: unknown) => {
      const result = await originalReaddir(dir, options);
      if (
        !swapped &&
        path.resolve(dir) === path.resolve(path.join(entries, "2026"))
      ) {
        swapped = true;
        await originalRemove(swapDir);
        await fs.symlink(outside, swapDir, "junction");
      }
      return result;
    };
    try {
      const found = await scanContainedMarkdownFiles(entries, root, [
        ".vs-journal",
      ]);
      assert.deepStrictEqual(
        found.map((f) => f.relativePath).sort(),
        ["2026/real.md"]
      );
    } finally {
      fsExtraModule.readdir = originalReaddir;
    }
  });
});
