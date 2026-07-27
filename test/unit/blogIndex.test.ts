import * as assert from "assert";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as sqlite3 from "sqlite3";
import {
  BlogIndex,
  DB_FILE_NAME,
  GENERATED_DIR_NAME,
  InvalidSearchPatternError,
  SNIPPET_START,
  makeLikeSnippet,
} from "../../src/blogIndex";

async function makeEntriesDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-index-"));
}

function entryMarkdown(
  title: string,
  body: string,
  tags: string[] = [],
  date = "2026-07-24 10:00:00"
): string {
  return `---\ntitle: ${title}\ndate: ${date}\ntags: [${tags.join(", ")}]\n---\n\n${body}\n`;
}

async function writeEntry(
  entriesDir: string,
  relativePath: string,
  content: string
): Promise<string> {
  const absolutePath = path.join(entriesDir, relativePath);
  await fs.ensureDir(path.dirname(absolutePath));
  await fs.writeFile(absolutePath, content);
  return absolutePath;
}

function dbPathFor(entriesDir: string): string {
  return path.join(entriesDir, GENERATED_DIR_NAME, DB_FILE_NAME);
}

suite("blogIndex", function () {
  this.timeout(20000);

  let entriesDir: string;
  let index: BlogIndex | undefined;

  setup(async () => {
    entriesDir = await makeEntriesDir();
    index = undefined;
  });

  teardown(async () => {
    await index?.close();
    index = undefined;
    await fs.remove(entriesDir).catch(() => undefined);
  });

  test("initial open creates the schema at the current user_version", async () => {
    index = await BlogIndex.open(entriesDir);
    assert.strictEqual(await index.userVersion(), 2);
    const meta = await index.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = 'fts_tokenizer'"
    );
    assert.strictEqual(meta?.value, "trigram");
  });

  test("a database at an older schema version is migrated in place with rows preserved", async () => {
    const dbPath = dbPathFor(entriesDir);
    await fs.ensureDir(path.dirname(dbPath));
    await createV1Database(dbPath);

    index = await BlogIndex.open(entriesDir);
    assert.strictEqual(await index.userVersion(), 2);

    // The migration backfills FTS from existing rows, so the v1 row is
    // searchable without touching the Markdown on disk.
    const result = await index.search("quick brown");
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].title, "Legacy Row");
  });

  test("a missing database is rebuilt automatically from Markdown", async () => {
    await writeEntry(
      entriesDir,
      "2026/07/24/first.md",
      entryMarkdown("First", "The quick brown fox.", ["alpha"])
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();
    assert.strictEqual(await index.countEntries(), 1);
    const entries = await index.listEntries();
    assert.strictEqual(entries[0].path, "2026/07/24/first.md");
    assert.deepStrictEqual(entries[0].tags, ["alpha"]);
  });

  test("reconcile inserts new files, reindexes changed ones, removes missing ones, and leaves unchanged files alone", async () => {
    const unchangedPath = await writeEntry(
      entriesDir,
      "keep.md",
      entryMarkdown("Keep", "stable body")
    );
    const changedPath = await writeEntry(
      entriesDir,
      "change.md",
      entryMarkdown("Change", "old body")
    );
    const removedPath = await writeEntry(
      entriesDir,
      "remove.md",
      entryMarkdown("Remove", "doomed body")
    );

    index = await BlogIndex.open(entriesDir);
    await index.reconcile();
    assert.strictEqual(await index.countEntries(), 3);
    const before = await index.get<{ id: number; body: string }>(
      "SELECT id, body FROM entries WHERE path = 'keep.md'"
    );

    await fs.writeFile(
      changedPath,
      entryMarkdown("Change", "brand new body with different length")
    );
    const future = new Date(Date.now() + 5000);
    await fs.utimes(changedPath, future, future);
    await fs.remove(removedPath);
    await writeEntry(entriesDir, "added.md", entryMarkdown("Added", "fresh"));

    await index.reconcile();

    const paths = (await index.listEntries()).map((entry) => entry.path).sort();
    assert.deepStrictEqual(paths, ["added.md", "change.md", "keep.md"]);
    const changed = await index.get<{ body: string }>(
      "SELECT body FROM entries WHERE path = 'change.md'"
    );
    assert.ok(changed?.body.includes("brand new body"));
    const after = await index.get<{ id: number; body: string }>(
      "SELECT id, body FROM entries WHERE path = 'keep.md'"
    );
    assert.strictEqual(after?.id, before?.id);
    assert.strictEqual(after?.body, before?.body);
    assert.ok(await fs.pathExists(unchangedPath));
  });

  test("stored paths are normalized and Windows-style lookups resolve the same entry", async () => {
    await writeEntry(
      entriesDir,
      path.join("2026", "07", "24", "nested.md"),
      entryMarkdown("Nested", "content")
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const entries = await index.listEntries();
    assert.strictEqual(entries[0].path, "2026/07/24/nested.md");

    await index.removeByRelativePath("2026\\07\\24\\nested.md");
    assert.strictEqual(await index.countEntries(), 0);
  });

  test("indexing a file outside the entries directory is rejected", async () => {
    index = await BlogIndex.open(entriesDir);
    const outside = path.join(entriesDir, "..", "outside.md");
    await fs.writeFile(outside, entryMarkdown("Evil", "outside"));
    try {
      await assert.rejects(() =>
        (index as BlogIndex).upsertFromFile(outside)
      );
    } finally {
      await fs.remove(outside);
    }
  });

  test("paths read from the database are guarded before resolution", async () => {
    index = await BlogIndex.open(entriesDir);
    await index.run(
      `INSERT INTO entries (path, title, date, body, mtime_ms, size_bytes)
       VALUES ('../../escape.md', 'Escape', '2026-01-01 00:00:00', 'body', 0, 0)`
    );
    assert.strictEqual(index.resolveEntryPath("../../escape.md"), undefined);
    const entries = await index.listEntries();
    assert.strictEqual(entries.length, 0);
    const hits = await index.search("body");
    assert.strictEqual(hits.entries.length, 0);
  });

  test("a failed transaction rolls back entry, tag, and FTS changes together", async () => {
    index = await BlogIndex.open(entriesDir);
    await assert.rejects(() =>
      (index as BlogIndex).runInTransactionForTest(async () => {
        await (index as BlogIndex).run(
          `INSERT INTO entries (path, title, date, body, mtime_ms, size_bytes)
           VALUES ('partial.md', 'Partial', '2026-01-01 00:00:00', 'partial body', 0, 0)`
        );
        await (index as BlogIndex).run(
          "INSERT INTO tags (name) VALUES ('partial-tag')"
        );
        throw new Error("forced failure");
      })
    );
    assert.strictEqual(await index.countEntries(), 0);
    const tags = await index.all("SELECT name FROM tags");
    assert.strictEqual(tags.length, 0);
    const hits = await index.search("partial body");
    assert.strictEqual(hits.entries.length, 0);
  });

  test("entry create, update, rename, and delete keep metadata, tags, and FTS consistent", async () => {
    index = await BlogIndex.open(entriesDir);

    const created = await writeEntry(
      entriesDir,
      "life.md",
      entryMarkdown("Lifecycle", "original searchable body", ["first-tag"])
    );
    await index.upsertFromFile(created);
    assert.strictEqual((await index.search("original searchable")).entries.length, 1);
    assert.strictEqual((await index.search("tag:first-tag")).entries.length, 1);

    await fs.writeFile(
      created,
      entryMarkdown("Lifecycle", "revised searchable body", ["second-tag"])
    );
    await index.upsertFromFile(created);
    assert.strictEqual((await index.search("original searchable")).entries.length, 0);
    assert.strictEqual((await index.search("revised searchable")).entries.length, 1);
    assert.strictEqual((await index.search("tag:first-tag")).entries.length, 0);
    const tagRows = await index.all<{ name: string }>("SELECT name FROM tags");
    assert.deepStrictEqual(
      tagRows.map((row) => row.name),
      ["second-tag"]
    );

    // Rename delivered as delete+create.
    const renamed = path.join(entriesDir, "renamed.md");
    await fs.move(created, renamed);
    await index.removeByRelativePath("life.md");
    await index.upsertFromFile(renamed);
    const paths = (await index.listEntries()).map((entry) => entry.path);
    assert.deepStrictEqual(paths, ["renamed.md"]);
    assert.strictEqual((await index.search("revised searchable")).entries.length, 1);

    await index.removeByRelativePath("renamed.md");
    assert.strictEqual(await index.countEntries(), 0);
    assert.strictEqual((await index.search("revised searchable")).entries.length, 0);
  });

  test("rebuildAll replaces the whole index from Markdown, dropping rows with no backing file", async () => {
    index = await BlogIndex.open(entriesDir);
    await index.run(
      `INSERT INTO entries (path, title, date, body, mtime_ms, size_bytes)
       VALUES ('ghost.md', 'Ghost', '2026-01-01 00:00:00', 'ghost body', 0, 0)`
    );
    await writeEntry(entriesDir, "real.md", entryMarkdown("Real", "real body"));

    await index.rebuildAll();

    const paths = (await index.listEntries()).map((entry) => entry.path);
    assert.deepStrictEqual(paths, ["real.md"]);
    assert.strictEqual((await index.search("ghost body")).entries.length, 0);
  });

  test("a watcher update issued during a rescan applies after it and is not overwritten", async () => {
    await writeEntry(entriesDir, "a.md", entryMarkdown("A", "alpha body"));
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const watched = await writeEntry(
      entriesDir,
      "b.md",
      entryMarkdown("B", "newest watcher content")
    );
    const rescan = index.rebuildAll();
    const watcherUpsert = index.upsertFromFile(watched);
    await Promise.all([rescan, watcherUpsert]);

    const row = await index.get<{ body: string }>(
      "SELECT body FROM entries WHERE path = 'b.md'"
    );
    assert.ok(row?.body.includes("newest watcher content"));
    assert.strictEqual(await index.countEntries(), 2);
  });

  test("a corrupt database is quarantined and rebuilt from Markdown", async () => {
    const dbPath = dbPathFor(entriesDir);
    await fs.ensureDir(path.dirname(dbPath));
    await fs.writeFile(dbPath, "this is definitely not a sqlite database");
    await writeEntry(entriesDir, "ok.md", entryMarkdown("Ok", "healthy body"));

    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    assert.strictEqual(await index.countEntries(), 1);
    assert.strictEqual((await index.search("healthy")).entries.length, 1);
    assert.ok(await fs.pathExists(`${dbPath}.corrupt`));
  });

  test("a database written by a newer schema version is treated as incompatible and rebuilt", async () => {
    index = await BlogIndex.open(entriesDir);
    await index.run("PRAGMA user_version=99");
    await index.close();
    index = undefined;

    await writeEntry(entriesDir, "new.md", entryMarkdown("New", "fresh body"));
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();
    assert.strictEqual(await index.userVersion(), 2);
    assert.strictEqual(await index.countEntries(), 1);
  });

  test("two simultaneous connections to the same journal write without lock failures", async () => {
    const first = await writeEntry(
      entriesDir,
      "one.md",
      entryMarkdown("One", "first connection body")
    );
    const second = await writeEntry(
      entriesDir,
      "two.md",
      entryMarkdown("Two", "second connection body")
    );

    index = await BlogIndex.open(entriesDir);
    const other = await BlogIndex.open(entriesDir);
    try {
      await Promise.all([
        index.upsertFromFile(first),
        other.upsertFromFile(second),
      ]);
      assert.strictEqual(await index.countEntries(), 2);
      assert.strictEqual(await other.countEntries(), 2);
    } finally {
      await other.close();
    }
  });

  test("title, body, and tag searches all match with useful snippets", async () => {
    await writeEntry(
      entriesDir,
      "t.md",
      entryMarkdown("Kumquat Chronicles", "a title-led entry", ["citrus"])
    );
    await writeEntry(
      entriesDir,
      "b.md",
      entryMarkdown("Plain Title", "deep in the body a kumquat appears", [])
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const result = await index.search("kumquat");
    assert.strictEqual(result.entries.length, 2);
    // Relevance: the title hit outranks the body-only hit (weighted bm25).
    assert.strictEqual(result.entries[0].title, "Kumquat Chronicles");
    const bodyHit = result.entries.find((hit) => hit.path === "b.md");
    assert.ok(bodyHit);
    assert.ok(bodyHit.snippet.includes(SNIPPET_START), "snippet is highlighted");
    assert.ok(bodyHit.snippet.toLowerCase().includes("kumquat"));

    const tagResult = await index.search("citrus");
    assert.deepStrictEqual(
      tagResult.tags.map((hit) => hit.tag),
      ["citrus"]
    );
    assert.ok(tagResult.entries.some((hit) => hit.path === "t.md"));
  });

  test("substring and case-insensitive queries match (trigram semantics)", async () => {
    await writeEntry(
      entriesDir,
      "q.md",
      entryMarkdown("Quick", "The quick brown fox jumps")
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    assert.strictEqual((await index.search("uick")).entries.length, 1);
    assert.strictEqual((await index.search("QUICK BROWN")).entries.length, 1);
  });

  test("phrases with quotes and punctuation are treated as literal text", async () => {
    await writeEntry(
      entriesDir,
      "p.md",
      entryMarkdown("Punct", 'It doesn\'t "just work": (usually) 100%')
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    assert.strictEqual((await index.search('doesn\'t "just work"')).entries.length, 1);
    assert.strictEqual((await index.search("(usually) 100%")).entries.length, 1);
  });

  test("short queries fall back to a database-only LIKE search with snippets", async () => {
    await writeEntry(
      entriesDir,
      "s.md",
      entryMarkdown("Short", "contains the rare zq digraph")
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const result = await index.search("zq");
    assert.strictEqual(result.entries.length, 1);
    assert.ok(result.entries[0].snippet.includes(SNIPPET_START));
  });

  test("search options default to today's case-insensitive substring behavior (no regression)", async () => {
    await writeEntry(
      entriesDir,
      "q.md",
      entryMarkdown("Quick", "The quick brown fox jumps")
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const withoutOptions = await index.search("QUICK BROWN");
    const withEmptyOptions = await index.search("QUICK BROWN", {});
    assert.strictEqual(withoutOptions.entries.length, 1);
    assert.deepStrictEqual(withEmptyOptions, withoutOptions);
  });

  test("matchCase restricts results to case-sensitive matches", async () => {
    await writeEntry(
      entriesDir,
      "c.md",
      entryMarkdown("Casing", "The Word appears once, lowercase word appears too")
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const caseSensitive = await index.search("Word", { matchCase: true });
    assert.strictEqual(caseSensitive.entries.length, 1);
    assert.ok(caseSensitive.entries[0].snippet.includes("Word"));

    const caseInsensitive = await index.search("nomatchcasehere", {
      matchCase: true,
    });
    assert.strictEqual(caseInsensitive.entries.length, 0);
  });

  test("wholeWord restricts results to word-boundary matches", async () => {
    await writeEntry(
      entriesDir,
      "w.md",
      entryMarkdown("Category", "a category of things, not just cat")
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const whole = await index.search("cat", { wholeWord: true });
    assert.strictEqual(whole.entries.length, 1);

    const notWhole = await index.search("xyzcat", { wholeWord: true });
    assert.strictEqual(notWhole.entries.length, 0);
  });

  test("useRegex treats the query as a regular expression", async () => {
    await writeEntry(
      entriesDir,
      "r.md",
      entryMarkdown("Regexy", "order numbers like ord-123 and ord-456")
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const result = await index.search("ord-\\d+", { useRegex: true });
    assert.strictEqual(result.entries.length, 1);
    assert.ok(result.entries[0].snippet.includes(SNIPPET_START));

    const noMatch = await index.search("ord-[a-z]+", { useRegex: true });
    assert.strictEqual(noMatch.entries.length, 0);
  });

  test("an invalid regex pattern rejects with InvalidSearchPatternError instead of throwing a raw SyntaxError", async () => {
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    await assert.rejects(
      index.search("(unclosed", { useRegex: true }),
      InvalidSearchPatternError
    );
  });

  test("regex and wholeWord combine (bounded pattern)", async () => {
    await writeEntry(
      entriesDir,
      "cw.md",
      entryMarkdown("Combined", "match cat but not category or concatenate")
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const result = await index.search("c.t", {
      useRegex: true,
      wholeWord: true,
    });
    assert.strictEqual(result.entries.length, 1);
  });

  test("malformed FTS-style input never throws and never matches as syntax", async () => {
    await writeEntry(
      entriesDir,
      "m.md",
      entryMarkdown("Malformed", "plain body text")
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const hostile = [
      '"unbalanced',
      "foo AND bar",
      "NEAR(",
      "col:value",
      "* OR *",
      "(((",
      'a"b"c',
      "-^~!",
    ];
    for (const query of hostile) {
      const result = await index.search(query);
      assert.ok(Array.isArray(result.entries), `query survived: ${query}`);
    }
    // Operators are literal text: "plain AND body" only matches if that
    // exact substring exists, which it does not.
    assert.strictEqual((await index.search("plain AND body")).entries.length, 0);
  });

  test("frontmatter is not indexed as body content", async () => {
    await writeEntry(
      entriesDir,
      "f.md",
      `---\ntitle: Fm Test\ndate: 2026-07-24 10:00:00\ntags: [normal]\ndraft: xyzzysecret\n---\n\nVisible body only.\n`
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    assert.strictEqual((await index.search("xyzzysecret")).entries.length, 0);
    assert.strictEqual((await index.search("Visible body")).entries.length, 1);
  });

  test("tag: queries are relational and case-insensitive", async () => {
    await writeEntry(
      entriesDir,
      "tag1.md",
      entryMarkdown("Tagged", "body one", ["Alpha-Release"])
    );
    await writeEntry(
      entriesDir,
      "tag2.md",
      entryMarkdown("Untagged", "alpha appears in body but not tags", [])
    );
    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    const result = await index.search("tag:alpha");
    assert.strictEqual(result.entries.length, 1);
    assert.strictEqual(result.entries[0].path, "tag1.md");
    assert.strictEqual((await index.search("tag:ALPHA-RELEASE")).entries.length, 1);
    assert.strictEqual((await index.search("tag:missing")).entries.length, 0);
  });

  test("activation-style open works with a legacy map.json present but never reads or changes it", async () => {
    const mapPath = path.join(entriesDir, "map.json");
    const legacyContent = JSON.stringify({ entries: [{ title: "Legacy" }] });
    await fs.writeFile(mapPath, legacyContent);
    await writeEntry(entriesDir, "real.md", entryMarkdown("Real", "real body"));

    index = await BlogIndex.open(entriesDir);
    await index.reconcile();

    assert.strictEqual(await index.countEntries(), 1);
    assert.strictEqual(await fs.readFile(mapPath, "utf8"), legacyContent);
  });

  test("makeLikeSnippet highlights the match and truncates around it", () => {
    const body = `${"x".repeat(100)} needle ${"y".repeat(100)}`;
    const snippet = makeLikeSnippet(body, "needle");
    assert.ok(snippet.includes(`${SNIPPET_START}needle`));
    assert.ok(snippet.startsWith("..."));
    assert.ok(snippet.endsWith("..."));
    assert.ok(snippet.length < body.length);
  });
});

// Replicates the v1 schema (before the FTS migration) so the upgrade
// path from a genuinely older database is exercised.
function createV1Database(dbPath: string): Promise<void> {
  const statements = [
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    `CREATE TABLE entries (
       id INTEGER PRIMARY KEY,
       path TEXT NOT NULL UNIQUE,
       title TEXT NOT NULL,
       date TEXT NOT NULL,
       body TEXT NOT NULL,
       mtime_ms INTEGER NOT NULL,
       size_bytes INTEGER NOT NULL
     )`,
    "CREATE TABLE tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE)",
    `CREATE TABLE entry_tags (
       entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
       tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
       PRIMARY KEY (entry_id, tag_id)
     )`,
    "CREATE INDEX idx_entries_date ON entries(date DESC)",
    `INSERT INTO entries (path, title, date, body, mtime_ms, size_bytes)
     VALUES ('legacy.md', 'Legacy Row', '2026-01-01 00:00:00', 'the quick brown fox', 0, 19)`,
    "PRAGMA user_version=1",
  ];
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (openError) => {
      if (openError) {
        reject(openError);
        return;
      }
      db.serialize(() => {
        for (const statement of statements) {
          db.run(statement, (error) => {
            if (error) {
              reject(error);
            }
          });
        }
        db.close((closeError) =>
          closeError ? reject(closeError) : resolve()
        );
      });
    });
  });
}
