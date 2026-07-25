import * as assert from "assert";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { createUniqueFile, isPathInside, normalizeEntryPath } from "../pathUtils";

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
