import * as assert from "assert";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  classifyMediaType,
  filterMediaFiles,
  formatBytes,
  hasSymlinkedAncestor,
  importMediaFile,
  isMediaRootDirectory,
  resolveContainedMediaFilePath,
  scanMediaDirectory,
  sortMediaFiles,
} from "../../src/mediaLibrary";
import { MediaFile } from "../../src/types";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-media-"));
}

// Windows requires elevated privileges or Developer Mode to create
// file symlinks (directory junctions are unprivileged, but file
// symlinks are not). Tests that need a symlink attempt creation and
// skip themselves if the platform refuses, rather than failing CI on
// machines without that privilege.
async function trySymlink(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "file");
    return true;
  } catch {
    return false;
  }
}

async function trySymlinkDir(target: string, linkPath: string): Promise<boolean> {
  try {
    await fs.symlink(target, linkPath, "junction");
    return true;
  } catch {
    return false;
  }
}

suite("mediaLibrary", () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await makeTempDir();
  });

  teardown(async () => {
    await fs.remove(tempDir);
  });

  test("classifyMediaType maps known extensions to image/audio/video, everything else to document", () => {
    assert.strictEqual(classifyMediaType("header.png"), "image");
    assert.strictEqual(classifyMediaType("photo.JPEG"), "image");
    assert.strictEqual(classifyMediaType("clip.mp3"), "audio");
    assert.strictEqual(classifyMediaType("movie.mp4"), "video");
    assert.strictEqual(classifyMediaType("report.pdf"), "document");
    assert.strictEqual(classifyMediaType("notes.txt"), "document");
    assert.strictEqual(classifyMediaType("no-extension"), "document");
    assert.strictEqual(classifyMediaType("archive.tar.gz"), "document");
  });

  test("scanMediaDirectory returns [] for a missing media root without throwing", async () => {
    const missing = path.join(tempDir, "does-not-exist");
    assert.deepStrictEqual(await scanMediaDirectory(missing), []);
  });

  test("scanMediaDirectory recurses subdirectories and normalizes relative paths", async () => {
    await fs.ensureDir(path.join(tempDir, "images", "2026"));
    await fs.writeFile(path.join(tempDir, "images", "2026", "header.png"), "a");
    await fs.writeFile(path.join(tempDir, "notes.pdf"), "b");

    const files = await scanMediaDirectory(tempDir);
    const paths = files.map((f) => f.path).sort();
    assert.deepStrictEqual(paths, ["images/2026/header.png", "notes.pdf"]);
    assert.ok(paths.every((p) => !p.includes("\\")));
  });

  test("scanMediaDirectory sorts newest mtime first, path as tie-breaker", async () => {
    const older = path.join(tempDir, "b-older.png");
    const newer = path.join(tempDir, "a-newer.png");
    const tiedA = path.join(tempDir, "tied-a.png");
    const tiedB = path.join(tempDir, "tied-z.png");
    await fs.writeFile(older, "x");
    await fs.writeFile(newer, "x");
    await fs.writeFile(tiedA, "x");
    await fs.writeFile(tiedB, "x");

    const now = Date.now() / 1000;
    await fs.utimes(older, now, now - 100);
    await fs.utimes(newer, now, now - 10);
    await fs.utimes(tiedA, now, now - 50);
    await fs.utimes(tiedB, now, now - 50);

    const files = await scanMediaDirectory(tempDir);
    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["a-newer.png", "tied-a.png", "tied-z.png", "b-older.png"]
    );
  });

  test("scanMediaDirectory excludes symlinked files without following them", async () => {
    const outsideDir = await makeTempDir();
    try {
      const secretFile = path.join(outsideDir, "secret.png");
      await fs.writeFile(secretFile, "secret");
      const linkPath = path.join(tempDir, "linked.png");
      const created = await trySymlink(secretFile, linkPath);
      if (!created) {
        return; // No symlink privilege on this machine; nothing to assert.
      }
      await fs.writeFile(path.join(tempDir, "real.png"), "real");

      const files = await scanMediaDirectory(tempDir);
      assert.deepStrictEqual(
        files.map((f) => f.path),
        ["real.png"]
      );
    } finally {
      await fs.remove(outsideDir);
    }
  });

  test("scanMediaDirectory excludes symlinked directories without descending into them", async () => {
    const outsideDir = await makeTempDir();
    try {
      await fs.writeFile(path.join(outsideDir, "hidden.png"), "hidden");
      const linkDir = path.join(tempDir, "linked-dir");
      const created = await trySymlinkDir(outsideDir, linkDir);
      if (!created) {
        return;
      }
      await fs.writeFile(path.join(tempDir, "real.png"), "real");

      const files = await scanMediaDirectory(tempDir);
      assert.deepStrictEqual(
        files.map((f) => f.path),
        ["real.png"]
      );
    } finally {
      await fs.remove(outsideDir);
    }
  });

  test("sortMediaFiles does not mutate its input array", () => {
    const files: MediaFile[] = [
      { path: "b.png", name: "b.png", type: "image", size: 1, mtimeMs: 1 },
      { path: "a.png", name: "a.png", type: "image", size: 1, mtimeMs: 2 },
    ];
    const original = [...files];
    sortMediaFiles(files);
    assert.deepStrictEqual(files, original);
  });

  test("filterMediaFiles matches filename and relative path case-insensitively", () => {
    const files: MediaFile[] = [
      { path: "images/Header.PNG", name: "Header.PNG", type: "image", size: 1, mtimeMs: 1 },
      { path: "clip.mp3", name: "clip.mp3", type: "audio", size: 1, mtimeMs: 2 },
    ];
    assert.deepStrictEqual(
      filterMediaFiles(files, { query: "header" }).map((f) => f.path),
      ["images/Header.PNG"]
    );
    assert.deepStrictEqual(
      filterMediaFiles(files, { query: "IMAGES/" }).map((f) => f.path),
      ["images/Header.PNG"]
    );
    assert.deepStrictEqual(filterMediaFiles(files, { query: "nope" }), []);
  });

  test("filterMediaFiles applies the type filter", () => {
    const files: MediaFile[] = [
      { path: "a.png", name: "a.png", type: "image", size: 1, mtimeMs: 1 },
      { path: "b.mp3", name: "b.mp3", type: "audio", size: 1, mtimeMs: 2 },
    ];
    assert.deepStrictEqual(
      filterMediaFiles(files, { type: "audio" }).map((f) => f.path),
      ["b.mp3"]
    );
    assert.deepStrictEqual(filterMediaFiles(files, { type: "all" }).length, 2);
  });

  test("formatBytes formats bytes, KB, MB, and GB", () => {
    assert.strictEqual(formatBytes(0), "0 B");
    assert.strictEqual(formatBytes(512), "512 B");
    assert.strictEqual(formatBytes(1024), "1.0 KB");
    assert.strictEqual(formatBytes(1536), "1.5 KB");
    assert.strictEqual(formatBytes(1024 * 1024), "1.0 MB");
    assert.strictEqual(formatBytes(1024 * 1024 * 1024), "1.0 GB");
  });

  test("importMediaFile creates the media root on demand and preserves the filename", async () => {
    const mediaRoot = path.join(tempDir, "media");
    const sourceDir = await makeTempDir();
    try {
      const sourceFile = path.join(sourceDir, "photo.png");
      await fs.writeFile(sourceFile, "content");

      const result = await importMediaFile(mediaRoot, sourceFile, "photo.png");
      assert.strictEqual(result.path, "photo.png");
      assert.strictEqual(await fs.pathExists(mediaRoot), true);
      assert.strictEqual(await fs.readFile(result.absolutePath, "utf8"), "content");
    } finally {
      await fs.remove(sourceDir);
    }
  });

  test("importMediaFile never overwrites a collision, using deterministic suffixes", async () => {
    const mediaRoot = path.join(tempDir, "media");
    const sourceDir = await makeTempDir();
    try {
      const first = path.join(sourceDir, "one.png");
      const second = path.join(sourceDir, "two.png");
      await fs.writeFile(first, "first");
      await fs.writeFile(second, "second");

      const firstResult = await importMediaFile(mediaRoot, first, "image.png");
      const secondResult = await importMediaFile(mediaRoot, second, "image.png");

      assert.strictEqual(firstResult.path, "image.png");
      assert.strictEqual(secondResult.path, "image-2.png");
      assert.strictEqual(
        await fs.readFile(path.join(mediaRoot, "image.png"), "utf8"),
        "first"
      );
      assert.strictEqual(
        await fs.readFile(path.join(mediaRoot, "image-2.png"), "utf8"),
        "second"
      );
    } finally {
      await fs.remove(sourceDir);
    }
  });

  test("resolveContainedMediaFilePath resolves a valid nested relative path", async () => {
    await fs.ensureDir(path.join(tempDir, "images"));
    const filePath = path.join(tempDir, "images", "header.png");
    await fs.writeFile(filePath, "x");

    const resolved = await resolveContainedMediaFilePath(tempDir, "images/header.png");
    assert.strictEqual(resolved, filePath);
  });

  test("resolveContainedMediaFilePath rejects traversal outside the media root", async () => {
    await fs.ensureDir(path.join(tempDir, "media"));
    await fs.writeFile(path.join(tempDir, "outside.png"), "x");
    const mediaRoot = path.join(tempDir, "media");

    assert.strictEqual(
      await resolveContainedMediaFilePath(mediaRoot, "../outside.png"),
      undefined
    );
    assert.strictEqual(
      await resolveContainedMediaFilePath(mediaRoot, "..\\..\\outside.png"),
      undefined
    );
  });

  test("resolveContainedMediaFilePath rejects absolute paths", async () => {
    const mediaRoot = path.join(tempDir, "media");
    await fs.ensureDir(mediaRoot);
    const absoluteElsewhere = path.join(tempDir, "outside.png");
    await fs.writeFile(absoluteElsewhere, "x");

    assert.strictEqual(
      await resolveContainedMediaFilePath(mediaRoot, absoluteElsewhere),
      undefined
    );
  });

  test("resolveContainedMediaFilePath rejects a missing file without throwing", async () => {
    const mediaRoot = path.join(tempDir, "media");
    await fs.ensureDir(mediaRoot);
    assert.strictEqual(
      await resolveContainedMediaFilePath(mediaRoot, "missing.png"),
      undefined
    );
  });

  test("resolveContainedMediaFilePath rejects a directory (not a regular file)", async () => {
    const mediaRoot = path.join(tempDir, "media");
    await fs.ensureDir(path.join(mediaRoot, "subdir"));
    assert.strictEqual(
      await resolveContainedMediaFilePath(mediaRoot, "subdir"),
      undefined
    );
  });

  test("resolveContainedMediaFilePath rejects a target reached through a symlinked directory", async () => {
    const mediaRoot = path.join(tempDir, "media");
    await fs.ensureDir(mediaRoot);
    const outsideDir = await makeTempDir();
    try {
      await fs.writeFile(path.join(outsideDir, "secret.png"), "secret");
      const linkDir = path.join(mediaRoot, "linked");
      const created = await trySymlinkDir(outsideDir, linkDir);
      if (!created) {
        return;
      }

      assert.strictEqual(
        await resolveContainedMediaFilePath(mediaRoot, "linked/secret.png"),
        undefined
      );
    } finally {
      await fs.remove(outsideDir);
    }
  });

  test("scanMediaDirectory throws when the media root itself is a symlink, rather than following it", async () => {
    const outsideDir = await makeTempDir();
    try {
      await fs.writeFile(path.join(outsideDir, "secret.png"), "secret");
      const mediaRoot = path.join(tempDir, "media-link");
      const created = await trySymlinkDir(outsideDir, mediaRoot);
      if (!created) {
        return;
      }

      await assert.rejects(() => scanMediaDirectory(mediaRoot));
    } finally {
      await fs.remove(outsideDir);
    }
  });

  test("resolveContainedMediaFilePath rejects everything when the media root itself is a symlink", async () => {
    const outsideDir = await makeTempDir();
    try {
      await fs.writeFile(path.join(outsideDir, "secret.png"), "secret");
      const mediaRoot = path.join(tempDir, "media-link");
      const created = await trySymlinkDir(outsideDir, mediaRoot);
      if (!created) {
        return;
      }

      assert.strictEqual(
        await resolveContainedMediaFilePath(mediaRoot, "secret.png"),
        undefined
      );
    } finally {
      await fs.remove(outsideDir);
    }
  });

  test("importMediaFile refuses to write through a pre-existing symlinked media root", async () => {
    const outsideDir = await makeTempDir();
    const sourceDir = await makeTempDir();
    try {
      const mediaRoot = path.join(tempDir, "media-link");
      const created = await trySymlinkDir(outsideDir, mediaRoot);
      if (!created) {
        return;
      }
      const sourceFile = path.join(sourceDir, "photo.png");
      await fs.writeFile(sourceFile, "content");

      await assert.rejects(() => importMediaFile(mediaRoot, sourceFile, "photo.png"));
      assert.strictEqual(await fs.pathExists(path.join(outsideDir, "photo.png")), false);
    } finally {
      await fs.remove(outsideDir);
      await fs.remove(sourceDir);
    }
  });

  test("resolveContainedMediaFilePath fails closed after a validated file is swapped for a directory (TOCTOU re-validation primitive)", async () => {
    const mediaRoot = path.join(tempDir, "media");
    await fs.ensureDir(mediaRoot);
    const filePath = path.join(mediaRoot, "photo.png");
    await fs.writeFile(filePath, "x");

    const firstResolve = await resolveContainedMediaFilePath(mediaRoot, "photo.png");
    assert.strictEqual(firstResolve, filePath);

    // Simulate the race a delete confirmation modal leaves open: the
    // file is removed and a directory takes its place before the
    // action actually runs.
    await fs.remove(filePath);
    await fs.ensureDir(filePath);

    const secondResolve = await resolveContainedMediaFilePath(mediaRoot, "photo.png");
    assert.strictEqual(secondResolve, undefined);
  });

  // Real permission failures are unreliable to construct portably (POSIX
  // ownership and Windows ACLs behave differently, and lstat-through-a-
  // file-ancestor turns out to report ENOENT rather than ENOTDIR on this
  // platform). Instead, monkeypatch the shared fs-extra module object
  // -- both mediaLibrary.ts and this test resolve the same singleton via
  // Node's require cache -- to force a deterministic non-ENOENT error
  // out of lstat, then restore it immediately after.
  //
  // Mutation has to go through a plain require() rather than the `fs`
  // namespace-import binding above: under esModuleInterop (mandatory
  // since TypeScript 6), `import * as fs` compiles to a getter-wrapped
  // copy whose properties are read-only and merely forward to the
  // underlying require()'d object -- so patching *that* object is what
  // both this test and mediaLibrary.ts's own `import * as fs` binding
  // will observe.
  const fsExtraModule: typeof fs = require("fs-extra");

  async function withPatchedLstat<T>(
    error: NodeJS.ErrnoException,
    run: () => Promise<T>
  ): Promise<T> {
    const original = fsExtraModule.lstat;
    (fsExtraModule as unknown as { lstat: unknown }).lstat = async () => {
      throw error;
    };
    try {
      return await run();
    } finally {
      (fsExtraModule as unknown as { lstat: unknown }).lstat = original;
    }
  }

  test("scanMediaDirectory propagates a non-ENOENT lstat failure instead of reporting a false empty library", async () => {
    const mediaRoot = path.join(tempDir, "media");
    const permissionError = Object.assign(new Error("EACCES"), { code: "EACCES" });

    await withPatchedLstat(permissionError, () =>
      assert.rejects(() => scanMediaDirectory(mediaRoot))
    );
  });

  async function withPatchedReaddir<T>(
    error: NodeJS.ErrnoException,
    failOn: (dir: string) => boolean,
    run: () => Promise<T>
  ): Promise<T> {
    const original = fsExtraModule.readdir;
    (fsExtraModule as unknown as { readdir: unknown }).readdir = async (
      dir: string,
      options: unknown
    ) => {
      if (failOn(dir)) {
        throw error;
      }
      return original(dir, options as never);
    };
    try {
      return await run();
    } finally {
      (fsExtraModule as unknown as { readdir: unknown }).readdir = original;
    }
  }

  test("scanMediaDirectory propagates a readdir failure on the media root itself instead of reporting a false empty library", async () => {
    const mediaRoot = path.join(tempDir, "media");
    await fs.ensureDir(mediaRoot);
    const permissionError = Object.assign(new Error("EACCES"), { code: "EACCES" });

    await withPatchedReaddir(
      permissionError,
      (dir) => path.resolve(dir) === path.resolve(mediaRoot),
      () => assert.rejects(() => scanMediaDirectory(mediaRoot))
    );
  });

  test("scanMediaDirectory skips (rather than fails) a readdir failure on a nested subdirectory", async () => {
    const mediaRoot = path.join(tempDir, "media");
    const unreadableDir = path.join(mediaRoot, "unreadable");
    await fs.ensureDir(unreadableDir);
    await fs.writeFile(path.join(mediaRoot, "root-file.png"), "x");
    await fs.writeFile(path.join(unreadableDir, "nested.png"), "x");
    const permissionError = Object.assign(new Error("EACCES"), { code: "EACCES" });

    const files = await withPatchedReaddir(
      permissionError,
      (dir) => path.resolve(dir) === path.resolve(unreadableDir),
      () => scanMediaDirectory(mediaRoot)
    );
    assert.deepStrictEqual(
      files.map((f) => f.path),
      ["root-file.png"]
    );
  });

  test("resolveContainedMediaFilePath propagates a non-ENOENT lstat failure on the media root", async () => {
    const mediaRoot = path.join(tempDir, "media");
    const permissionError = Object.assign(new Error("EACCES"), { code: "EACCES" });

    await withPatchedLstat(permissionError, () =>
      assert.rejects(() => resolveContainedMediaFilePath(mediaRoot, "photo.png"))
    );
  });

  test("hasSymlinkedAncestor is false when every ancestor between workspaceRoot and mediaRoot is a real directory", async () => {
    const workspaceRoot = tempDir;
    const mediaRoot = path.join(workspaceRoot, "blog", "media");
    await fs.ensureDir(mediaRoot);

    assert.strictEqual(await hasSymlinkedAncestor(workspaceRoot, mediaRoot), false);
  });

  test("hasSymlinkedAncestor is false when mediaRoot does not exist yet (normal lazy-creation state)", async () => {
    const workspaceRoot = tempDir;
    const mediaRoot = path.join(workspaceRoot, "blog", "media");

    assert.strictEqual(await hasSymlinkedAncestor(workspaceRoot, mediaRoot), false);
  });

  test("hasSymlinkedAncestor is true when the blog directory (an ancestor of media root) is a symlink", async () => {
    const workspaceRoot = tempDir;
    const outsideDir = await makeTempDir();
    try {
      const blogLink = path.join(workspaceRoot, "blog");
      const created = await trySymlinkDir(outsideDir, blogLink);
      if (!created) {
        return;
      }
      const mediaRoot = path.join(blogLink, "media");

      assert.strictEqual(await hasSymlinkedAncestor(workspaceRoot, mediaRoot), true);
    } finally {
      await fs.remove(outsideDir);
    }
  });

  test("hasSymlinkedAncestor does not flag mediaRoot itself, only its ancestors", async () => {
    const workspaceRoot = tempDir;
    const outsideDir = await makeTempDir();
    try {
      const blogDir = path.join(workspaceRoot, "blog");
      await fs.ensureDir(blogDir);
      const mediaLink = path.join(blogDir, "media");
      const created = await trySymlinkDir(outsideDir, mediaLink);
      if (!created) {
        return;
      }

      // mediaRoot itself being a symlink is statMediaRoot's concern,
      // not hasSymlinkedAncestor's -- ancestors only.
      assert.strictEqual(await hasSymlinkedAncestor(workspaceRoot, mediaLink), false);
    } finally {
      await fs.remove(outsideDir);
    }
  });

  test("hasSymlinkedAncestor treats a non-ENOENT lstat failure on an ancestor as unsafe, not as a missing ancestor", async () => {
    const workspaceRoot = tempDir;
    const mediaRoot = path.join(workspaceRoot, "blog", "media");
    const permissionError = Object.assign(new Error("EACCES"), { code: "EACCES" });

    await withPatchedLstat(permissionError, async () => {
      assert.strictEqual(await hasSymlinkedAncestor(workspaceRoot, mediaRoot), true);
    });
  });

  test("isMediaRootDirectory is true only for a real, existing directory", async () => {
    const mediaRoot = path.join(tempDir, "media");
    assert.strictEqual(await isMediaRootDirectory(mediaRoot), false, "missing root");

    await fs.ensureDir(mediaRoot);
    assert.strictEqual(await isMediaRootDirectory(mediaRoot), true, "real directory");
  });

  test("isMediaRootDirectory never throws, even when lstat fails unexpectedly", async () => {
    const mediaRoot = path.join(tempDir, "media");
    const permissionError = Object.assign(new Error("EACCES"), { code: "EACCES" });

    await withPatchedLstat(permissionError, async () => {
      assert.strictEqual(await isMediaRootDirectory(mediaRoot), false);
    });
  });

  test("a media root replaced by a symlink after files were loaded is no longer treated as a safe resource root (webview resource-root regression)", async () => {
    const outsideDir = await makeTempDir();
    try {
      const mediaRoot = path.join(tempDir, "media");
      await fs.ensureDir(mediaRoot);
      await fs.writeFile(path.join(mediaRoot, "photo.png"), "real content");

      // First load: a real directory with a real file -- this is the
      // state a webview would have already rendered previews against.
      const filesBeforeSwap = await scanMediaDirectory(mediaRoot);
      assert.strictEqual(filesBeforeSwap.length, 1);
      assert.strictEqual(await isMediaRootDirectory(mediaRoot), true);

      // The directory is now replaced by a symlink pointing elsewhere,
      // simulating the swap between one refresh and the next.
      await fs.remove(mediaRoot);
      const created = await trySymlinkDir(outsideDir, mediaRoot);
      if (!created) {
        return;
      }

      // The resource-root check must flip to unsafe, and a rescan must
      // reject rather than silently listing whatever is now at that
      // path -- both are required so a caller (MediaController) has no
      // path left to keep exposing the old, or a new attacker-
      // controlled, resource root.
      assert.strictEqual(await isMediaRootDirectory(mediaRoot), false);
      await assert.rejects(() => scanMediaDirectory(mediaRoot));
    } finally {
      await fs.remove(outsideDir);
    }
  });
});
