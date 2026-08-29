import * as assert from "assert";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  DEFAULT_MEDIA_PATH,
  createUniqueCopy,
  createUniqueFile,
  isPathInside,
  normalizeEntryPath,
  resolveContainedMediaDir,
  toPortableBlogRelativePath,
  toWorkspaceRelativeDisplayPath,
} from "../../src/pathUtils";

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-paths-"));
}

suite("pathUtils", () => {
  let tempDir: string;

  setup(async () => {
    tempDir = await makeTempDir();
  });

  teardown(async () => {
    await fs.remove(tempDir);
  });

  test("createUniqueFile allocates distinct filenames under concurrent collision (no TOCTOU race)", async () => {
    const [first, second] = await Promise.all([
      createUniqueFile(tempDir, "my-post.md", "first"),
      createUniqueFile(tempDir, "my-post.md", "second"),
    ]);

    assert.notStrictEqual(first, second);

    const firstContent = await fs.readFile(first, "utf8");
    const secondContent = await fs.readFile(second, "utf8");
    assert.ok(
      (firstContent === "first" && secondContent === "second") ||
        (firstContent === "second" && secondContent === "first"),
      "each allocated file must retain the content its own call wrote"
    );
  });

  test("isPathInside rejects a sibling directory that merely shares a path-prefix substring", () => {
    const entriesDir = path.join(tempDir, "entries");
    const siblingDir = path.join(tempDir, "entries-archive");

    assert.strictEqual(
      isPathInside(path.join(siblingDir, "file.md"), entriesDir),
      false
    );
    assert.strictEqual(
      isPathInside(path.join(entriesDir, "2026", "file.md"), entriesDir),
      true
    );
  });

  test("isPathInside rejects traversal that escapes the parent", () => {
    const entriesDir = path.join(tempDir, "entries");
    assert.strictEqual(
      isPathInside(path.join(entriesDir, "..", "..", "evil.md"), entriesDir),
      false
    );
  });

  test("createUniqueCopy copies file content and preserves the filename when there is no collision", async () => {
    const sourcePath = path.join(tempDir, "source.png");
    await fs.writeFile(sourcePath, "image-bytes");
    const destDir = path.join(tempDir, "dest");
    await fs.ensureDir(destDir);

    const copied = await createUniqueCopy(destDir, "photo.png", sourcePath);

    assert.strictEqual(copied, path.join(destDir, "photo.png"));
    assert.strictEqual(await fs.readFile(copied, "utf8"), "image-bytes");
  });

  test("createUniqueCopy never overwrites a collision, using deterministic suffixes", async () => {
    const sourcePath = path.join(tempDir, "source.png");
    await fs.writeFile(sourcePath, "new-bytes");
    const destDir = path.join(tempDir, "dest");
    await fs.ensureDir(destDir);
    await fs.writeFile(path.join(destDir, "photo.png"), "existing-bytes");

    const copied = await createUniqueCopy(destDir, "photo.png", sourcePath);

    assert.strictEqual(copied, path.join(destDir, "photo-2.png"));
    assert.strictEqual(
      await fs.readFile(path.join(destDir, "photo.png"), "utf8"),
      "existing-bytes"
    );
    assert.strictEqual(await fs.readFile(copied, "utf8"), "new-bytes");
  });

  test("createUniqueCopy allocates distinct filenames under concurrent collision (no TOCTOU race)", async () => {
    const destDir = path.join(tempDir, "dest");
    await fs.ensureDir(destDir);
    const sourceA = path.join(tempDir, "a.png");
    const sourceB = path.join(tempDir, "b.png");
    await fs.writeFile(sourceA, "a-bytes");
    await fs.writeFile(sourceB, "b-bytes");

    const [first, second] = await Promise.all([
      createUniqueCopy(destDir, "shared.png", sourceA),
      createUniqueCopy(destDir, "shared.png", sourceB),
    ]);

    assert.notStrictEqual(first, second);
    const firstContent = await fs.readFile(first, "utf8");
    const secondContent = await fs.readFile(second, "utf8");
    assert.ok(
      (firstContent === "a-bytes" && secondContent === "b-bytes") ||
        (firstContent === "b-bytes" && secondContent === "a-bytes"),
      "each allocated copy must retain the content its own call copied"
    );
  });

  test("resolveContainedMediaDir falls back to the default media subdirectory for blank config", () => {
    const blogDir = path.join(tempDir, "blog");
    const expected = path.join(blogDir, DEFAULT_MEDIA_PATH);
    assert.strictEqual(resolveContainedMediaDir(blogDir, undefined), expected);
    assert.strictEqual(resolveContainedMediaDir(blogDir, ""), expected);
    assert.strictEqual(resolveContainedMediaDir(blogDir, "   "), expected);
  });

  test("resolveContainedMediaDir resolves a nested blog-relative path", () => {
    const blogDir = path.join(tempDir, "blog");
    assert.strictEqual(
      resolveContainedMediaDir(blogDir, "assets/pics"),
      path.join(blogDir, "assets", "pics")
    );
  });

  test("resolveContainedMediaDir rejects traversal, absolute paths, and the blog directory itself", () => {
    const blogDir = path.join(tempDir, "blog");
    assert.strictEqual(resolveContainedMediaDir(blogDir, "../outside"), undefined);
    assert.strictEqual(
      resolveContainedMediaDir(blogDir, "media/../../outside"),
      undefined
    );
    assert.strictEqual(
      resolveContainedMediaDir(blogDir, path.join(tempDir, "abs")),
      undefined
    );
    assert.strictEqual(resolveContainedMediaDir(blogDir, "."), undefined);
    assert.strictEqual(resolveContainedMediaDir(blogDir, "sub/.."), undefined);
  });

  test("resolveContainedMediaDir rejects a case-only variant of the blog directory (case-insensitive filesystems)", () => {
    const blogDir = path.join(tempDir, "blog");
    // On Windows, path.relative() is case-insensitive, so "../BLOG"
    // resolves back to blogDir with only a casing difference: a plain
    // string equality check misses it and the blog root leaks through
    // as the media root.
    const caseVariant = "../" + path.basename(blogDir).toUpperCase();
    assert.strictEqual(resolveContainedMediaDir(blogDir, caseVariant), undefined);
  });

  test("resolveContainedMediaDir accepts a contained directory whose name starts with two dots", () => {
    const blogDir = path.join(tempDir, "blog");
    // "..assets" is an ordinary contained subdirectory, not traversal --
    // a bare startsWith("..") check would wrongly reject it.
    assert.strictEqual(
      resolveContainedMediaDir(blogDir, "..assets"),
      path.join(blogDir, "..assets")
    );
    assert.strictEqual(
      resolveContainedMediaDir(blogDir, "..assets/pics"),
      path.join(blogDir, "..assets", "pics")
    );
  });

  test("toPortableBlogRelativePath converts a contained selection to a forward-slash relative path", () => {
    const blogDir = path.join(tempDir, "blog");
    assert.strictEqual(
      toPortableBlogRelativePath(blogDir, path.join(blogDir, "assets", "pics")),
      "assets/pics"
    );
  });

  test("toPortableBlogRelativePath rejects the blog directory itself and directories outside it", () => {
    const blogDir = path.join(tempDir, "blog");
    assert.strictEqual(toPortableBlogRelativePath(blogDir, blogDir), undefined);
    assert.strictEqual(
      toPortableBlogRelativePath(blogDir, path.join(tempDir, "elsewhere")),
      undefined
    );
    assert.strictEqual(
      toPortableBlogRelativePath(blogDir, path.join(blogDir, "..", "sibling")),
      undefined
    );
  });

  test("toPortableBlogRelativePath accepts a contained directory whose name starts with two dots", () => {
    const blogDir = path.join(tempDir, "blog");
    assert.strictEqual(
      toPortableBlogRelativePath(blogDir, path.join(blogDir, "..assets")),
      "..assets"
    );
    assert.strictEqual(
      toPortableBlogRelativePath(blogDir, path.join(blogDir, "..assets", "pics")),
      "..assets/pics"
    );
  });

  test("toWorkspaceRelativeDisplayPath formats a contained directory as a forward-slash relative label", () => {
    const workspaceRoot = path.join(tempDir, "ws");
    assert.strictEqual(
      toWorkspaceRelativeDisplayPath(
        workspaceRoot,
        path.join(workspaceRoot, "blog", "assets")
      ),
      "blog/assets"
    );
  });

  test("toWorkspaceRelativeDisplayPath returns a portable label for a directory that need not exist", () => {
    const workspaceRoot = path.join(tempDir, "ws");
    // Pure string formatting -- no filesystem access, so a not-yet-created
    // media directory still yields its configured display label.
    assert.strictEqual(
      toWorkspaceRelativeDisplayPath(
        workspaceRoot,
        path.join(workspaceRoot, "blog", "media-does-not-exist")
      ),
      "blog/media-does-not-exist"
    );
  });

  test("toWorkspaceRelativeDisplayPath labels a contained directory whose name starts with two dots", () => {
    const workspaceRoot = path.join(tempDir, "ws");
    // A workspace-root blog (blogPath ".") with mediaPath "..assets"
    // resolves to a legitimately contained directory -- its label must
    // match, not read "unavailable", so heading and reveal target agree.
    assert.strictEqual(
      toWorkspaceRelativeDisplayPath(
        workspaceRoot,
        path.join(workspaceRoot, "..assets")
      ),
      "..assets"
    );
    assert.strictEqual(
      toWorkspaceRelativeDisplayPath(
        workspaceRoot,
        path.join(workspaceRoot, "..assets", "pics")
      ),
      "..assets/pics"
    );
  });

  test("toWorkspaceRelativeDisplayPath rejects the workspace root itself and anything outside it", () => {
    const workspaceRoot = path.join(tempDir, "ws");
    assert.strictEqual(
      toWorkspaceRelativeDisplayPath(workspaceRoot, workspaceRoot),
      undefined
    );
    assert.strictEqual(
      toWorkspaceRelativeDisplayPath(
        workspaceRoot,
        path.join(tempDir, "outside")
      ),
      undefined
    );
    assert.strictEqual(
      toWorkspaceRelativeDisplayPath(
        workspaceRoot,
        path.join(workspaceRoot, "..", "sibling")
      ),
      undefined
    );
  });

  test("normalizeEntryPath converts Windows separators to forward slashes", () => {
    assert.strictEqual(
      normalizeEntryPath("2026\\07\\23\\hello.md"),
      "2026/07/23/hello.md"
    );
    assert.strictEqual(
      normalizeEntryPath("2026/07/23/hello.md"),
      "2026/07/23/hello.md"
    );
  });
});
