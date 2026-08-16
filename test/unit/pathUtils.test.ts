import * as assert from "assert";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import {
  createUniqueCopy,
  createUniqueFile,
  isPathInside,
  normalizeEntryPath,
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
