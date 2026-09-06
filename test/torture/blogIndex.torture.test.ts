import * as assert from "assert";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { BlogIndex } from "../../src/blogIndex";

const ENTRY_COUNT = 250;
const RECONCILE_PASSES = 5;

function markdown(index: number): string {
  return (
    `---\ntitle: Torture Entry ${index}\n` +
    `date: 2026-07-26 12:${(index % 60).toString().padStart(2, "0")}:00\n` +
    `tags: [batch-${index % 10}]\n---\n\n` +
    `Deterministic torture payload ${index}.\n`
  );
}

suite("blog index torture", function () {
  this.timeout(120000);

  let entriesDir: string;
  let index: BlogIndex | undefined;

  setup(async () => {
    entriesDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "vs-journal-torture-")
    );
  });

  teardown(async () => {
    await index?.close();
    await fs.remove(entriesDir).catch(() => undefined);
  });

  test("repeatedly reconciles a bounded large journal without losing entries", async () => {
    for (let item = 0; item < ENTRY_COUNT; item++) {
      const directory = path.join(
        entriesDir,
        "2026",
        "07",
        (item % 28 + 1).toString().padStart(2, "0")
      );
      await fs.ensureDir(directory);
      await fs.writeFile(path.join(directory, `entry-${item}.md`), markdown(item));
    }

    index = await BlogIndex.open(entriesDir, path.dirname(entriesDir));
    for (let pass = 0; pass < RECONCILE_PASSES; pass++) {
      await index.reconcile();
      assert.strictEqual(await index.countEntries(), ENTRY_COUNT);
    }

    const search = await index.search("Deterministic torture payload");
    assert.ok(search.entries.length > 0);
    assert.ok(search.entries.length <= ENTRY_COUNT);
    assert.ok(
      search.entries.every((entry) =>
        entry.snippet.includes("Deterministic torture payload")
      )
    );
  });
});
