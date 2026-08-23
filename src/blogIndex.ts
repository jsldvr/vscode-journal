import * as fs from "fs-extra";
import * as path from "path";
import * as sqlite3 from "sqlite3";
import moment = require("moment");
import { isPathInside, normalizeEntryPath } from "./pathUtils";
import { parseEntryContent } from "./frontmatter";
import { BlogEntry } from "./types";

// Generated state lives under <entries>/.vs-journal/. Markdown remains
// authoritative; everything in this directory is disposable and is
// rebuilt from the entry files whenever it is missing, corrupt, or
// written by an incompatible schema version.
export const GENERATED_DIR_NAME = ".vs-journal";
export const DB_FILE_NAME = "index.sqlite3";

// Snippet highlight markers. The webview splits on these and wraps the
// highlighted ranges; they never survive into rendered HTML.
export const SNIPPET_START = "\u0001";
export const SNIPPET_END = "\u0002";

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
const JS_SNIPPET_RADIUS = 30;

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

// Thrown when useRegex is set and the query does not compile; callers
// surface this as a friendly inline message instead of a generic
// search failure.
export class InvalidSearchPatternError extends Error {}

interface EntryFileStat {
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
}

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

  readonly entriesDir: string;
  readonly dbPath: string;

  private constructor(entriesDir: string) {
    this.entriesDir = entriesDir;
    this.dbPath = path.join(entriesDir, GENERATED_DIR_NAME, DB_FILE_NAME);
  }

  static async open(entriesDir: string): Promise<BlogIndex> {
    const index = new BlogIndex(entriesDir);
    await index.initialize();
    return index;
  }

  // -- lifecycle ----------------------------------------------------------

  private async initialize(): Promise<void> {
    await fs.ensureDir(path.dirname(this.dbPath));
    try {
      await this.connectAndMigrate();
    } catch (error) {
      console.error(
        "VS Journal: index database unusable, rebuilding:",
        error instanceof Error ? error.message : error
      );
      await this.recoverFromBadDatabase();
    }
  }

  private async connectAndMigrate(): Promise<void> {
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
    await quarantineGeneratedFiles(this.dbPath);
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
    const [content, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8"),
      fs.stat(absolutePath),
    ]);
    const relativePath = normalizeEntryPath(
      path.relative(this.entriesDir, absolutePath)
    );
    const entry = toIndexedEntry(relativePath, content, stat.mtimeMs, stat.size);
    await this.enqueue(() =>
      this.runTransaction(async () => {
        await this.writeEntry(entry);
        await this.pruneOrphanTags();
      })
    );
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
  async reconcile(): Promise<void> {
    await this.enqueue(async () => {
      const files = await scanEntryFiles(this.entriesDir);
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

      const parsed = await parseEntryFiles(stale);
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
      const files = await scanEntryFiles(this.entriesDir);
      const parsed = await parseEntryFiles(files);
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

  // JS-side scan used only when matchCase/wholeWord/useRegex is active.
  // These modes can't be expressed as an FTS5 MATCH or a LIKE pattern,
  // so this bypasses the index entirely and filters every entry's
  // title/body in memory -- acceptable at personal-journal scale, the
  // same scale the LIKE fallback already assumes.
  private async searchWithPattern(
    query: string,
    options: SearchOptions
  ): Promise<SearchHit[]> {
    const pattern = buildSearchPattern(query, options);
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
    const hits: SearchHit[] = [];
    for (const row of rows) {
      if (!this.isSafeRelativePath(row.path)) {
        continue;
      }
      const bodyMatch = pattern.exec(row.body);
      if (!bodyMatch && !pattern.test(row.title)) {
        continue;
      }
      hits.push({
        title: row.title,
        date: row.date,
        path: row.path,
        tags: splitConcatenatedTags(row.tags),
        snippet: makeMatchSnippet(row.body, bodyMatch),
      });
      if (hits.length >= SEARCH_LIMIT) {
        break;
      }
    }
    return hits;
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

  resolveEntryPath(relativePath: string): string | undefined {
    if (!this.isSafeRelativePath(relativePath)) {
      return undefined;
    }
    return path.resolve(this.entriesDir, relativePath);
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
  files: EntryFileStat[]
): Promise<IndexedEntryData[]> {
  const parsed: IndexedEntryData[] = [];
  for (const file of files) {
    try {
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

async function scanEntryFiles(entriesDir: string): Promise<EntryFileStat[]> {
  if (!(await fs.pathExists(entriesDir))) {
    return [];
  }
  const found: EntryFileStat[] = [];
  await walkForMarkdown(entriesDir, entriesDir, found);
  return found;
}

async function walkForMarkdown(
  dir: string,
  entriesDir: string,
  found: EntryFileStat[]
): Promise<void> {
  let items: string[];
  try {
    items = await fs.readdir(dir);
  } catch (error) {
    console.error(`Error reading directory ${dir}:`, error);
    return;
  }
  for (const item of items) {
    if (item === GENERATED_DIR_NAME) {
      continue;
    }
    await collectMarkdownItem(path.join(dir, item), entriesDir, found);
  }
}

async function collectMarkdownItem(
  fullPath: string,
  entriesDir: string,
  found: EntryFileStat[]
): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.stat(fullPath);
  } catch (error) {
    console.error(`Error reading ${fullPath}:`, error);
    return;
  }
  if (stat.isDirectory()) {
    await walkForMarkdown(fullPath, entriesDir, found);
    return;
  }
  if (fullPath.endsWith(".md")) {
    found.push({
      absolutePath: fullPath,
      relativePath: normalizeEntryPath(path.relative(entriesDir, fullPath)),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
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

function truncatedHead(body: string): string {
  const head = body.slice(0, JS_SNIPPET_RADIUS * 2).trim();
  return head.length < body.trim().length ? `${head}...` : head;
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

// Snippet for the matchCase/wholeWord/useRegex scan, built from a
// RegExpExecArray instead of a literal query. A zero-length match (an
// all-optional regex) is treated the same as "no match" -- there is
// nothing meaningful to highlight.
export function makeMatchSnippet(
  body: string,
  match: RegExpExecArray | null
): string {
  if (!match || match[0].length === 0) {
    return truncatedHead(body);
  }
  const position = match.index;
  const length = match[0].length;
  const start = Math.max(0, position - JS_SNIPPET_RADIUS);
  const end = Math.min(body.length, position + length + JS_SNIPPET_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < body.length ? "..." : "";
  const before = body.slice(start, position);
  const matched = body.slice(position, position + length);
  const after = body.slice(position + length, end);
  return `${prefix}${before}${SNIPPET_START}${matched}${SNIPPET_END}${after}${suffix}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Builds the RegExp for the matchCase/wholeWord/useRegex scan. Thrown
// SyntaxErrors from an invalid useRegex pattern are normalized to
// InvalidSearchPatternError so callers don't need to know RegExp's
// error shape.
function buildSearchPattern(query: string, options: SearchOptions): RegExp {
  const source = options.useRegex ? query : escapeRegExp(query);
  const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source;
  const flags = options.matchCase ? "" : "i";
  try {
    return new RegExp(bounded, flags);
  } catch {
    throw new InvalidSearchPatternError("Invalid regular expression");
  }
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
// previous quarantine) and removes WAL/SHM sidecars. Only generated
// files under .vs-journal/ are touched.
async function quarantineGeneratedFiles(dbPath: string): Promise<void> {
  const quarantinePath = `${dbPath}.corrupt`;
  await fs.remove(quarantinePath).catch(() => undefined);
  if (await fs.pathExists(dbPath)) {
    await fs.move(dbPath, quarantinePath).catch(() => fs.remove(dbPath));
  }
  await fs.remove(`${dbPath}-wal`).catch(() => undefined);
  await fs.remove(`${dbPath}-shm`).catch(() => undefined);
}
