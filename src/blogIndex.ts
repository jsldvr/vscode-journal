import * as fs from "fs-extra";
import * as path from "path";
import * as sqlite3 from "sqlite3";
import moment = require("moment");
import { isPathInside, normalizeEntryPath } from "./pathUtils";
import {
  EntryContainmentError,
  ScannedEntryFile,
  assertGeneratedFileMovable,
  assertSafeExistingFile,
  assertSafeGeneratedState,
  createSafeContainedDirectory,
  generatedDatabasePaths,
  resolveSafeExistingEntryFile,
  scanContainedMarkdownFiles,
} from "./entryContainment";
import { parseEntryContent } from "./frontmatter";
import { BlogEntry } from "./types";
import {
  JS_SNIPPET_RADIUS,
  SNIPPET_END,
  SNIPPET_START,
  buildPatternSpec,
  compilePattern,
  truncatedHead,
} from "./regexMatch";
import { RegexSearchPool } from "./regexSearchPool";

// Re-exported so existing importers (searchView, the unit suite) keep a
// single entry point for search errors and snippet helpers even though
// the pattern-matching internals now live in dedicated modules that the
// worker thread can load without sqlite3.
export { SNIPPET_START, SNIPPET_END };
export { InvalidSearchPatternError, makeMatchSnippet } from "./regexMatch";
export {
  RegexSearchError,
  RegexSearchTimeoutError,
  RegexSearchCancelledError,
} from "./regexSearchPool";

// Generated state lives under <entries>/.vs-journal/. Markdown remains
// authoritative; everything in this directory is disposable and is
// rebuilt from the entry files whenever it is missing, corrupt, or
// written by an incompatible schema version.
export const GENERATED_DIR_NAME = ".vs-journal";
export const DB_FILE_NAME = "index.sqlite3";

const SCHEMA_VERSION = 2;
// Documented busy timeout: a second extension host (two VS Code windows
// on the same journal) retries for up to 5s instead of failing with
// SQLITE_BUSY. Combined with WAL mode this makes routine concurrent
// reads/writes lock-free.
const BUSY_TIMEOUT_MS = 5000;
const SEARCH_LIMIT = 100;
// A trigram token advances one character at a time, so snippet token
// counts are roughly characters; 64 is the FTS5 maximum.
const SNIPPET_TOKENS = 64;

export interface SearchHit extends BlogEntry {
  snippet: string;
}

export interface TagHit {
  tag: string;
  count: number;
}

export interface SearchResponse {
  query: string;
  entries: SearchHit[];
  tags: TagHit[];
}

export interface SearchOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}

type EntryFileStat = ScannedEntryFile;

interface EntryRow {
  title: string;
  date: string;
  path: string;
}

type Migration = (index: BlogIndex) => Promise<void>;

export class BlogIndex {
  private db: sqlite3.Database | undefined;
  private writeQueue: Promise<void> = Promise.resolve();
  private ftsAvailable = false;
  // Isolates the matchCase/wholeWord/useRegex scan on a worker thread
  // with an enforced per-request deadline so a pathological pattern
  // cannot block the extension host. Created eagerly (no worker is
  // spawned until the first pattern search) and torn down by close().
  private readonly regexPool = new RegexSearchPool();
  // Strictly increasing id assigned in search-submission order and
  // carried into regexPool.run(). The database read in
  // searchWithPattern can finish out of submission order, so the pool
  // needs this to tell "newer search" from "read that happened to
  // return last" and never let the latter cancel the former's worker.
  private searchRequestSequence = 0;

  readonly entriesDir: string;
  readonly dbPath: string;
  // The workspace trust anchor. Every generated/entry path is validated
  // as lexically contained below this and reachable only through real,
  // non-symlink directory components. BlogIndex never infers trust from
  // entriesDir alone.
  readonly trustAnchor: string;
  private readonly generatedDir: string;

  private constructor(entriesDir: string, trustAnchor: string) {
    this.entriesDir = entriesDir;
    this.trustAnchor = trustAnchor;
    this.generatedDir = path.join(entriesDir, GENERATED_DIR_NAME);
    this.dbPath = path.join(this.generatedDir, DB_FILE_NAME);
  }

  static async open(
    entriesDir: string,
    trustAnchor: string
  ): Promise<BlogIndex> {
    const index = new BlogIndex(entriesDir, trustAnchor);
    await index.initialize();
    return index;
  }

  // -- lifecycle ----------------------------------------------------------

  private async initialize(): Promise<void> {
    // The entries directory must already exist as a real directory below
    // the trust anchor (IndexHost owns its deliberate creation). The
    // generated .vs-journal directory is disposable state and may be
    // created here, but only through validated real components.
    await createSafeContainedDirectory(
      this.trustAnchor,
      this.generatedDir,
      "unsafe-generated"
    );
    try {
      await this.connectAndMigrate();
    } catch (error) {
      if (error instanceof EntryContainmentError) {
        throw error;
      }
      console.error(
        "VS Journal: index database unusable, rebuilding:",
        error instanceof Error ? error.message : error
      );
      await this.recoverFromBadDatabase();
    }
  }

  private async connectAndMigrate(): Promise<void> {
    await assertSafeGeneratedState(
      this.trustAnchor,
      this.entriesDir,
      this.generatedDir,
      this.dbPath
    );
    this.db = await openDatabase(this.dbPath);
    this.db.configure("busyTimeout", BUSY_TIMEOUT_MS);
    await this.run(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
    await this.all("PRAGMA journal_mode=WAL");
    await this.run("PRAGMA foreign_keys=ON");
    await this.assertHealthy();
    await this.migrate();
    this.ftsAvailable = (await this.getMeta("fts_tokenizer")) === "trigram";
  }

  // Recovery touches only generated files: the database itself is moved
  // aside (never deleted, in case it needs inspection) and the WAL/SHM
  // sidecars are removed. Markdown is never modified. The caller is
  // expected to run reconcile()/rebuildAll() afterwards, which refills
  // the fresh schema from the Markdown source of truth.
  private async recoverFromBadDatabase(): Promise<void> {
    await this.closeQuietly();
    // Revalidate the generated tree before touching any file on the
    // recovery path; a symlinked db/quarantine/sidecar must abort
    // recovery, never be moved or removed.
    await assertSafeGeneratedState(
      this.trustAnchor,
      this.entriesDir,
      this.generatedDir,
      this.dbPath
    );
    await quarantineGeneratedFiles(
      this.trustAnchor,
      this.generatedDir,
      this.dbPath
    );
    await this.connectAndMigrate();
  }

  private async assertHealthy(): Promise<void> {
    const rows = await this.all<{ quick_check: string }>("PRAGMA quick_check");
    if (rows.length === 0 || rows[0].quick_check !== "ok") {
      throw new Error("index database failed quick_check");
    }
  }

  async close(): Promise<void> {
    await this.enqueue(async () => {
      await this.closeQuietly();
    });
    // Independent of the write queue and the database connection: the
    // regex worker owns no SQLite handle. Disposing here terminates any
    // in-flight worker and rejects its pending promise, so a search
    // running while the index closes settles instead of leaking.
    await this.regexPool.dispose();
  }

  private closeQuietly(): Promise<void> {
    const db = this.db;
    this.db = undefined;
    if (!db) {
      return Promise.resolve();
    }
    return new Promise((resolve) => db.close(() => resolve()));
  }

  // -- migrations ---------------------------------------------------------

  private async migrate(): Promise<void> {
    const current = await this.userVersion();
    if (current > SCHEMA_VERSION) {
      throw new Error(
        `index schema version ${current} is newer than supported version ${SCHEMA_VERSION}`
      );
    }
    for (let version = current; version < SCHEMA_VERSION; version++) {
      await this.applyMigration(version);
    }
  }

  private async applyMigration(fromVersion: number): Promise<void> {
    await this.run("BEGIN IMMEDIATE");
    try {
      await MIGRATIONS[fromVersion](this);
      await this.run(`PRAGMA user_version=${fromVersion + 1}`);
      await this.run("COMMIT");
    } catch (error) {
      await this.run("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  async userVersion(): Promise<number> {
    const rows = await this.all<{ user_version: number }>(
      "PRAGMA user_version"
    );
    return rows[0].user_version;
  }

  private async getMeta(key: string): Promise<string | undefined> {
    const row = await this.get<{ value: string }>(
      "SELECT value FROM meta WHERE key = ?",
      [key]
    );
    return row?.value;
  }

  // -- mutation (all serialized through the write queue) ------------------

  // Serializes writers in-process so a full rescan and a concurrent
  // watcher upsert can never interleave: whichever is queued later runs
  // strictly after the earlier one commits. Cross-process writers are
  // handled by SQLite itself (WAL + busy timeout).
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = () => fn();
    const result = this.writeQueue.then(run, run);
    this.writeQueue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  private async runTransaction(fn: () => Promise<void>): Promise<void> {
    await this.run("BEGIN IMMEDIATE");
    try {
      await fn();
      await this.run("COMMIT");
    } catch (error) {
      await this.run("ROLLBACK").catch(() => undefined);
      throw error;
    }
  }

  // Exposed for transactional-rollback regression tests only.
  async runInTransactionForTest(fn: () => Promise<void>): Promise<void> {
    return this.enqueue(() => this.runTransaction(fn));
  }

  async upsertFromFile(absolutePath: string): Promise<void> {
    if (!isPathInside(absolutePath, this.entriesDir)) {
      throw new Error(
        `Refusing to index a file outside the entries directory: ${absolutePath}`
      );
    }
    // Physical containment immediately before the read: no linked
    // ancestor, no linked final component, and the target is a regular
    // file. fs.lstat semantics -- fs.stat would follow a link.
    await assertSafeExistingFile(this.trustAnchor, absolutePath, "unsafe-entry");
    const [content, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8"),
      fs.lstat(absolutePath),
    ]);
    const relativePath = normalizeEntryPath(
      path.relative(this.entriesDir, absolutePath)
    );
    const entry = toIndexedEntry(relativePath, content, stat.mtimeMs, stat.size);
    await this.enqueue(async () => {
      // Revalidate before committing indexed content: a path swapped
      // between the read and the transaction must not enter the index.
      await assertSafeExistingFile(
        this.trustAnchor,
        absolutePath,
        "unsafe-entry"
      );
      await this.runTransaction(async () => {
        await this.writeEntry(entry);
        await this.pruneOrphanTags();
      });
    });
  }

  async removeByRelativePath(relativePath: string): Promise<void> {
    const normalized = normalizeEntryPath(relativePath);
    await this.enqueue(() =>
      this.runTransaction(async () => {
        await this.run("DELETE FROM entries WHERE path = ?", [normalized]);
        await this.pruneOrphanTags();
      })
    );
  }

  // Activation-time reconciliation: inserts new files, re-indexes files
  // whose mtime or size changed, removes rows for missing files, and
  // leaves unchanged files untouched. Runs entirely inside the write
  // queue so watcher events observed mid-scan apply after it.
  // Safe Markdown scan for reconcile/rebuild: skips the generated
  // directory, never follows a symlink or junction, and revalidates the
  // entries directory and its ancestors. A formerly real subtree that is
  // now a link simply stops appearing here, so reconcile's diff prunes
  // its rows.
  private scanFiles(): Promise<ScannedEntryFile[]> {
    return scanContainedMarkdownFiles(this.entriesDir, this.trustAnchor, [
      GENERATED_DIR_NAME,
    ]);
  }

  async reconcile(): Promise<void> {
    await this.enqueue(async () => {
      const files = await this.scanFiles();
      const rows = await this.all<{
        path: string;
        mtime_ms: number;
        size_bytes: number;
      }>("SELECT path, mtime_ms, size_bytes FROM entries");
      const known = new Map(rows.map((row) => [row.path, row]));

      const stale = files.filter((file) => {
        const row = known.get(file.relativePath);
        return (
          !row ||
          row.mtime_ms !== Math.floor(file.mtimeMs) ||
          row.size_bytes !== file.size
        );
      });
      const present = new Set(files.map((file) => file.relativePath));
      const removed = rows
        .map((row) => row.path)
        .filter((entryPath) => !present.has(entryPath));

      const parsed = await parseEntryFiles(this.trustAnchor, stale);
      await this.runTransaction(async () => {
        for (const entry of parsed) {
          await this.writeEntry(entry);
        }
        for (const entryPath of removed) {
          await this.run("DELETE FROM entries WHERE path = ?", [entryPath]);
        }
        await this.pruneOrphanTags();
      });
    });
  }

  // Forced rebuild for the manual rescan command: the scan runs inside
  // the write queue and the replacement is a single transaction, so a
  // watcher update queued during the rescan lands after it and cannot
  // be overwritten by stale scan data.
  async rebuildAll(): Promise<void> {
    await this.enqueue(async () => {
      const files = await this.scanFiles();
      const parsed = await parseEntryFiles(this.trustAnchor, files);
      await this.runTransaction(async () => {
        await this.run("DELETE FROM entries");
        await this.run("DELETE FROM tags");
        for (const entry of parsed) {
          await this.writeEntry(entry);
        }
      });
    });
  }

  private async writeEntry(entry: IndexedEntryData): Promise<void> {
    await this.run(
      `INSERT INTO entries (path, title, date, body, mtime_ms, size_bytes)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET
         title = excluded.title,
         date = excluded.date,
         body = excluded.body,
         mtime_ms = excluded.mtime_ms,
         size_bytes = excluded.size_bytes`,
      [
        entry.path,
        entry.title,
        entry.date,
        entry.body,
        entry.mtimeMs,
        entry.size,
      ]
    );
    const row = await this.get<{ id: number }>(
      "SELECT id FROM entries WHERE path = ?",
      [entry.path]
    );
    if (!row) {
      throw new Error(`entry row missing after upsert: ${entry.path}`);
    }
    await this.run("DELETE FROM entry_tags WHERE entry_id = ?", [row.id]);
    for (const tag of entry.tags) {
      await this.run("INSERT OR IGNORE INTO tags (name) VALUES (?)", [tag]);
      await this.run(
        `INSERT OR IGNORE INTO entry_tags (entry_id, tag_id)
         SELECT ?, id FROM tags WHERE name = ?`,
        [row.id, tag]
      );
    }
  }

  private async pruneOrphanTags(): Promise<void> {
    await this.run(
      "DELETE FROM tags WHERE id NOT IN (SELECT DISTINCT tag_id FROM entry_tags)"
    );
  }

  // -- queries ------------------------------------------------------------

  async countEntries(): Promise<number> {
    const row = await this.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM entries"
    );
    return row ? row.n : 0;
  }

  async listEntries(): Promise<BlogEntry[]> {
    const rows = await this.all<EntryRow & { tags: string | null }>(
      `SELECT e.title, e.date, e.path,
              (SELECT GROUP_CONCAT(t.name, char(31))
                 FROM entry_tags et JOIN tags t ON t.id = et.tag_id
                WHERE et.entry_id = e.id) AS tags
         FROM entries e
        ORDER BY e.date DESC`
    );
    return rows
      .filter((row) => this.isSafeRelativePath(row.path))
      .map((row) => ({
        title: row.title,
        date: row.date,
        path: row.path,
        tags: splitConcatenatedTags(row.tags),
      }));
  }

  // Toggle options (matchCase/wholeWord/useRegex) apply only to plain
  // free-text queries. tag: queries and tag-name suggestion chips keep
  // their existing case-insensitive substring behavior regardless of
  // toggle state -- deliberately out of scope, see requirements.
  async search(
    rawQuery: string,
    options: SearchOptions = {}
  ): Promise<SearchResponse> {
    const query = rawQuery.trim();
    if (query.length === 0) {
      return { query, entries: [], tags: [] };
    }
    if (query.toLowerCase().startsWith("tag:")) {
      const term = query.slice(4).trim();
      return {
        query,
        entries: term.length === 0 ? [] : await this.searchByTagTerm(term),
        tags: [],
      };
    }
    const hasToggles = Boolean(
      options.matchCase || options.wholeWord || options.useRegex
    );
    const entries = hasToggles
      ? await this.searchWithPattern(query, options)
      : await this.searchFullText(query);
    const tags = await this.searchTagNames(query);
    return { query, entries, tags };
  }

  // Relational, case-insensitive tag query (substring match on the tag
  // name, preserving the previous tag: behavior).
  private async searchByTagTerm(term: string): Promise<SearchHit[]> {
    const pattern = likeContains(term);
    const rows = await this.all<EntryRow & { tags: string | null }>(
      `SELECT DISTINCT e.title, e.date, e.path,
              (SELECT GROUP_CONCAT(t2.name, char(31))
                 FROM entry_tags et2 JOIN tags t2 ON t2.id = et2.tag_id
                WHERE et2.entry_id = e.id) AS tags
         FROM entries e
         JOIN entry_tags et ON et.entry_id = e.id
         JOIN tags t ON t.id = et.tag_id
        WHERE t.name LIKE ? ESCAPE '\\'
        ORDER BY e.date DESC
        LIMIT ${SEARCH_LIMIT}`,
      [pattern]
    );
    return rows
      .filter((row) => this.isSafeRelativePath(row.path))
      .map((row) => ({
        title: row.title,
        date: row.date,
        path: row.path,
        tags: splitConcatenatedTags(row.tags),
        snippet: "",
      }));
  }

  private async searchFullText(query: string): Promise<SearchHit[]> {
    const primary =
      this.ftsAvailable && query.length >= 3
        ? await this.searchWithFts(query)
        : await this.searchWithLike(query);
    const byPath = new Map(primary.map((hit) => [hit.path, hit]));
    const tagged = await this.searchByTagTerm(query);
    for (const hit of tagged) {
      if (!byPath.has(hit.path)) {
        primary.push(hit);
        byPath.set(hit.path, hit);
      }
    }
    return primary;
  }

  // Ordinary user input is treated as literal text: the whole query is
  // wrapped in one double-quoted FTS phrase (embedded quotes doubled),
  // so FTS5 operators, parentheses, and malformed syntax are inert.
  // With the trigram tokenizer a quoted phrase is an arbitrary
  // case-insensitive substring match, preserving the previous search
  // semantics. Results are ranked by bm25 with the title weighted
  // above the body.
  private async searchWithFts(query: string): Promise<SearchHit[]> {
    const phrase = `"${query.replace(/"/g, '""')}"`;
    const rows = await this.all<
      EntryRow & { tags: string | null; snip: string }
    >(
      `SELECT e.title, e.date, e.path,
              snippet(entry_fts, 1, char(1), char(2), '...', ${SNIPPET_TOKENS}) AS snip,
              (SELECT GROUP_CONCAT(t.name, char(31))
                 FROM entry_tags et JOIN tags t ON t.id = et.tag_id
                WHERE et.entry_id = e.id) AS tags
         FROM entry_fts
         JOIN entries e ON e.id = entry_fts.rowid
        WHERE entry_fts MATCH ?
        ORDER BY bm25(entry_fts, 10.0, 1.0)
        LIMIT ${SEARCH_LIMIT}`,
      [phrase]
    );
    return rows
      .filter((row) => this.isSafeRelativePath(row.path))
      .map((row) => ({
        title: row.title,
        date: row.date,
        path: row.path,
        tags: splitConcatenatedTags(row.tags),
        snippet: row.snip,
      }));
  }

  // Database-only fallback for short queries (a trigram MATCH needs at
  // least 3 characters) and for hosts whose SQLite build lacks the
  // trigram tokenizer. Never reads Markdown files: title and body come
  // from the entries table. Title matches rank first, then recency.
  private async searchWithLike(query: string): Promise<SearchHit[]> {
    const pattern = likeContains(query);
    const rows = await this.all<
      EntryRow & { tags: string | null; body: string }
    >(
      `SELECT e.title, e.date, e.path, e.body,
              (SELECT GROUP_CONCAT(t.name, char(31))
                 FROM entry_tags et JOIN tags t ON t.id = et.tag_id
                WHERE et.entry_id = e.id) AS tags
         FROM entries e
        WHERE e.title LIKE ? ESCAPE '\\' OR e.body LIKE ? ESCAPE '\\'
        ORDER BY CASE WHEN e.title LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
                 e.date DESC
        LIMIT ${SEARCH_LIMIT}`,
      [pattern, pattern, pattern]
    );
    return rows
      .filter((row) => this.isSafeRelativePath(row.path))
      .map((row) => ({
        title: row.title,
        date: row.date,
        path: row.path,
        tags: splitConcatenatedTags(row.tags),
        snippet: makeLikeSnippet(row.body, query),
      }));
  }

  // Scan used only when matchCase/wholeWord/useRegex is active. These
  // modes can't be expressed as an FTS5 MATCH or a LIKE pattern, so the
  // index is bypassed and every entry's title/body is matched in memory
  // -- acceptable at personal-journal scale, the same scale the LIKE
  // fallback already assumes. The match itself runs on a worker thread
  // (see RegexSearchPool): a catastrophic pattern can block whatever
  // thread evaluates it, so it must never be the extension host's.
  // Ordering (date descending), the SEARCH_LIMIT cap, the title
  // fallback, and snippet shape are unchanged from the previous
  // in-process scan.
  private async searchWithPattern(
    query: string,
    options: SearchOptions
  ): Promise<SearchHit[]> {
    // Assigned before the (reorderable) database read so the pool sees
    // requests in submission order, not read-completion order.
    const requestId = ++this.searchRequestSequence;
    const spec = buildPatternSpec(query, options);
    // Compile once on the host purely to reject an invalid pattern with
    // the friendly InvalidSearchPatternError before a worker is spawned;
    // RegExp compilation is bounded, only matching is not.
    compilePattern(spec);
    const rows = await this.all<
      EntryRow & { tags: string | null; body: string }
    >(
      `SELECT e.title, e.date, e.path, e.body,
              (SELECT GROUP_CONCAT(t.name, char(31))
                 FROM entry_tags et JOIN tags t ON t.id = et.tag_id
                WHERE et.entry_id = e.id) AS tags
         FROM entries e
        ORDER BY e.date DESC`
    );
    const safeRows = rows.filter((row) => this.isSafeRelativePath(row.path));
    const hits = await this.regexPool.run({
      id: requestId,
      rows: safeRows.map((row) => ({
        path: row.path,
        title: row.title,
        body: row.body,
      })),
      spec,
      limit: SEARCH_LIMIT,
    });
    const rowByPath = new Map(safeRows.map((row) => [row.path, row]));
    return hits.map((hit) => {
      const row = rowByPath.get(hit.path);
      return {
        title: row?.title ?? "",
        date: row?.date ?? "",
        path: hit.path,
        tags: splitConcatenatedTags(row?.tags ?? null),
        snippet: hit.snippet,
      };
    });
  }

  private async searchTagNames(query: string): Promise<TagHit[]> {
    const pattern = likeContains(query);
    const rows = await this.all<{ name: string; n: number }>(
      `SELECT t.name, COUNT(et.entry_id) AS n
         FROM tags t
         LEFT JOIN entry_tags et ON et.tag_id = t.id
        WHERE t.name LIKE ? ESCAPE '\\'
        GROUP BY t.id
        ORDER BY n DESC, t.name ASC`,
      [pattern]
    );
    return rows.map((row) => ({ tag: row.name, count: row.n }));
  }

  // Path-containment guard applied to every path read back from the
  // database before it can be resolved to the filesystem.
  isSafeRelativePath(relativePath: string): boolean {
    const resolved = path.resolve(this.entriesDir, relativePath);
    return isPathInside(resolved, this.entriesDir);
  }

  // Synchronous lexical-only resolution. Retained for the row filter
  // (isSafeRelativePath) and callers that only need the lexical form;
  // entry opening must use resolveSafeExistingEntryPath instead.
  resolveEntryPath(relativePath: string): string | undefined {
    if (!this.isSafeRelativePath(relativePath)) {
      return undefined;
    }
    return path.resolve(this.entriesDir, relativePath);
  }

  // Async safe resolution for entry opening: lexical containment plus
  // real, non-symlink directory components down to an existing regular
  // file. Returns undefined (never throws) for a lexical escape, a
  // linked component, a missing file, or a non-regular target.
  resolveSafeExistingEntryPath(
    relativePath: string
  ): Promise<string | undefined> {
    return resolveSafeExistingEntryFile(this.entriesDir, relativePath);
  }

  // -- low-level promisified sqlite3 helpers ------------------------------

  private database(): sqlite3.Database {
    if (!this.db) {
      throw new Error("index database is closed");
    }
    return this.db;
  }

  run(sql: string, params: unknown[] = []): Promise<void> {
    const db = this.database();
    return new Promise((resolve, reject) => {
      db.run(sql, params, (error) => (error ? reject(error) : resolve()));
    });
  }

  get<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
    const db = this.database();
    return new Promise((resolve, reject) => {
      db.get(sql, params, (error, row) =>
        error ? reject(error) : resolve(row as T | undefined)
      );
    });
  }

  all<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    const db = this.database();
    return new Promise((resolve, reject) => {
      db.all(sql, params, (error, rows) =>
        error ? reject(error) : resolve(rows as T[])
      );
    });
  }
}

// -- schema migrations ----------------------------------------------------

// Migration 1: relational core. Tag names are case-insensitively unique
// (COLLATE NOCASE); entry paths are unique normalized forward-slash
// relative paths; entry_tags cascades on delete from either side.
async function migration1(index: BlogIndex): Promise<void> {
  await index.run(
    `CREATE TABLE meta (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL
     )`
  );
  await index.run(
    `CREATE TABLE entries (
       id INTEGER PRIMARY KEY,
       path TEXT NOT NULL UNIQUE,
       title TEXT NOT NULL,
       date TEXT NOT NULL,
       body TEXT NOT NULL,
       mtime_ms INTEGER NOT NULL,
       size_bytes INTEGER NOT NULL
     )`
  );
  await index.run(
    `CREATE TABLE tags (
       id INTEGER PRIMARY KEY,
       name TEXT NOT NULL UNIQUE COLLATE NOCASE
     )`
  );
  await index.run(
    `CREATE TABLE entry_tags (
       entry_id INTEGER NOT NULL REFERENCES entries(id) ON DELETE CASCADE,
       tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
       PRIMARY KEY (entry_id, tag_id)
     )`
  );
  await index.run("CREATE INDEX idx_entries_date ON entries(date DESC)");
}

// Migration 2: FTS5 index over title and body using the trigram
// tokenizer (arbitrary substring matching), kept in sync with entries
// by triggers so every metadata change and its FTS update commit in
// the same transaction. If this SQLite build lacks the trigram
// tokenizer the schema records that fact and search uses the LIKE
// fallback exclusively.
async function migration2(index: BlogIndex): Promise<void> {
  const created = await createFtsTable(index);
  await index.run("INSERT INTO meta (key, value) VALUES ('fts_tokenizer', ?)", [
    created ? "trigram" : "none",
  ]);
  if (!created) {
    return;
  }
  await index.run(
    `CREATE TRIGGER entries_fts_insert AFTER INSERT ON entries BEGIN
       INSERT INTO entry_fts(rowid, title, body)
       VALUES (new.id, new.title, new.body);
     END`
  );
  await index.run(
    `CREATE TRIGGER entries_fts_delete AFTER DELETE ON entries BEGIN
       INSERT INTO entry_fts(entry_fts, rowid, title, body)
       VALUES ('delete', old.id, old.title, old.body);
     END`
  );
  await index.run(
    `CREATE TRIGGER entries_fts_update AFTER UPDATE ON entries BEGIN
       INSERT INTO entry_fts(entry_fts, rowid, title, body)
       VALUES ('delete', old.id, old.title, old.body);
       INSERT INTO entry_fts(rowid, title, body)
       VALUES (new.id, new.title, new.body);
     END`
  );
  await index.run(
    "INSERT INTO entry_fts(rowid, title, body) SELECT id, title, body FROM entries"
  );
}

async function createFtsTable(index: BlogIndex): Promise<boolean> {
  try {
    await index.run(
      `CREATE VIRTUAL TABLE entry_fts USING fts5(
         title, body,
         content='entries', content_rowid='id',
         tokenize='trigram'
       )`
    );
    return true;
  } catch (error) {
    console.error(
      "VS Journal: FTS5 trigram tokenizer unavailable, using LIKE fallback:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

const MIGRATIONS: Migration[] = [migration1, migration2];

// -- filesystem scanning and parsing --------------------------------------

interface IndexedEntryData {
  path: string;
  title: string;
  date: string;
  body: string;
  tags: string[];
  mtimeMs: number;
  size: number;
}

function toIndexedEntry(
  relativePath: string,
  content: string,
  mtimeMs: number,
  size: number
): IndexedEntryData {
  const parsed = parseEntryContent(content);
  return {
    path: relativePath,
    title: parsed.title || path.basename(relativePath, ".md"),
    // `date` stays authoritative when an entry carries both keys; the
    // Astro-style `pubDate` only fills in for entries that omit `date`.
    date:
      parsed.date || parsed.pubDate || moment().format("YYYY-MM-DD HH:mm:ss"),
    body: parsed.body,
    tags: parsed.tags,
    mtimeMs: Math.floor(mtimeMs),
    size,
  };
}

async function parseEntryFiles(
  trustAnchor: string,
  files: EntryFileStat[]
): Promise<IndexedEntryData[]> {
  const parsed: IndexedEntryData[] = [];
  for (const file of files) {
    try {
      // Revalidate at the read boundary: the safe scan produced this
      // list, but a component may have been swapped for a link since.
      await assertSafeExistingFile(
        trustAnchor,
        file.absolutePath,
        "unsafe-entry"
      );
      const content = await fs.readFile(file.absolutePath, "utf8");
      parsed.push(
        toIndexedEntry(file.relativePath, content, file.mtimeMs, file.size)
      );
    } catch (error) {
      console.error(`Failed to parse entry ${file.absolutePath}:`, error);
    }
  }
  return parsed;
}

// -- small pure helpers ---------------------------------------------------

const TAG_SEPARATOR = "\u001f";

function splitConcatenatedTags(value: string | null): string[] {
  if (!value) {
    return [];
  }
  return value.split(TAG_SEPARATOR).filter((tag) => tag.length > 0);
}

export function escapeLikePattern(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

function likeContains(term: string): string {
  return `%${escapeLikePattern(term)}%`;
}

// JS-side snippet for the LIKE fallback, built from the already-indexed
// body (no Markdown file reads), using the same highlight markers as
// the FTS snippet() output.
export function makeLikeSnippet(body: string, query: string): string {
  const lowerBody = body.toLowerCase();
  const position = lowerBody.indexOf(query.toLowerCase());
  if (position < 0) {
    return truncatedHead(body);
  }
  const start = Math.max(0, position - JS_SNIPPET_RADIUS);
  const end = Math.min(body.length, position + query.length + JS_SNIPPET_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < body.length ? "..." : "";
  const before = body.slice(start, position);
  const matched = body.slice(position, position + query.length);
  const after = body.slice(position + query.length, end);
  return `${prefix}${before}${SNIPPET_START}${matched}${SNIPPET_END}${after}${suffix}`;
}

function openDatabase(dbPath: string): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(dbPath, (error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(db);
    });
  });
}

// Moves a bad database aside as index.sqlite3.corrupt (replacing any
// previous quarantine) and removes the rollback-journal and WAL/SHM
// sidecars. The exact set of paths comes from generatedDatabasePaths()
// -- the same definition the open guard validates -- so the two cannot
// drift. Only generated files under .vs-journal/ are touched, and every
// path is lstat-checked immediately before it is moved or removed: a
// symlinked generated path aborts recovery (EntryContainmentError)
// instead of following the link.
async function quarantineGeneratedFiles(
  trustAnchor: string,
  generatedDir: string,
  dbPath: string
): Promise<void> {
  const { db, quarantine, sidecars } = generatedDatabasePaths(dbPath);
  const movable = (target: string) =>
    assertGeneratedFileMovable(trustAnchor, generatedDir, target);
  if ((await movable(quarantine)) === "safe") {
    await fs.remove(quarantine).catch(() => undefined);
  }
  if ((await movable(db)) === "safe") {
    await fs.move(db, quarantine).catch(() => fs.remove(db));
  }
  for (const sidecar of sidecars) {
    if ((await movable(sidecar)) === "safe") {
      await fs.remove(sidecar).catch(() => undefined);
    }
  }
}
