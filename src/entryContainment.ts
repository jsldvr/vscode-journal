// Symlink-safe containment policy for journal entries and the generated
// SQLite index. VS Code-independent and side-effect-free on import so the
// unit suite can exercise every function directly against real temp
// directories.
//
// The workspace root is the trust anchor: it is accepted as-is and never
// inspected. Every path below it that the entry subsystem reads, writes,
// opens, indexes, moves, or deletes must be lexically contained and must
// resolve through real, non-symlink directory components to a real target
// of the expected type. An existing symlink or Windows junction anywhere
// on the path is rejected even when its target stays inside the workspace
// -- linked entry trees are unsupported, not resolved.
//
// Portability note: these checks use portable Node lstat/realpath-style
// APIs. They prevent stable links and, with action-boundary revalidation
// by callers, close the practical check/use gap, but they cannot provide
// openat-style path-confinement and do not claim freedom from an
// adversarial filesystem race.

import * as fs from "fs-extra";
import * as path from "path";
import { Dirent } from "fs";
import { isPathInside, normalizeEntryPath } from "./pathUtils";

export type EntryContainmentErrorKind =
  | "unsafe-root"
  | "unsafe-entry"
  | "unsafe-generated";

// Carries a machine-usable `kind` so the extension can show a message
// tailored to an unsafe configured journal root, an unsafe entry path, or
// an unsafe generated database path without parsing strings.
export class EntryContainmentError extends Error {
  readonly kind: EntryContainmentErrorKind;
  readonly target: string;

  constructor(kind: EntryContainmentErrorKind, target: string, detail: string) {
    super(`${detail}: ${target}`);
    this.name = "EntryContainmentError";
    this.kind = kind;
    this.target = target;
  }
}

export interface ScannedEntryFile {
  absolutePath: string;
  relativePath: string;
  mtimeMs: number;
  size: number;
}

type DirectoryState = "real" | "missing" | "unsafe";

function errno(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

// lstat a single path and classify it. ENOENT is the only "not there yet"
// state; a symlink/junction or a non-directory is "unsafe"; any other
// lstat failure is re-thrown so the caller fails closed rather than
// treating an unverifiable path as safe.
async function statDirectory(target: string): Promise<DirectoryState> {
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return "unsafe";
  }
  return "real";
}

function segmentsBetween(anchor: string, target: string): string[] {
  const relative = path.relative(anchor, target);
  return relative.split(path.sep).filter((segment) => segment.length > 0);
}

export interface ChainResult {
  // "ok": every component from the anchor down to the target exists as a
  // real directory. "missing": the chain was real up to a component that
  // does not exist yet (allowed only when the caller opted in).
  status: "ok" | "missing";
  // Absolute path of the first component that did not exist, when
  // status === "missing".
  firstMissing?: string;
}

// Walks every path component strictly below `anchor` up to and including
// `target`, requiring each existing component to be a real, non-symlink
// directory. `anchor` itself is trusted and never inspected. Throws
// EntryContainmentError on a symlink/junction/non-directory component and
// re-throws unexpected lstat errors (fail closed). A missing component is
// an error unless `allowMissingTail` is set, in which case the walk stops
// at the first missing component and reports it.
export async function verifyContainedRealDirectoryChain(
  anchor: string,
  target: string,
  kind: EntryContainmentErrorKind,
  options: { allowMissingTail?: boolean } = {}
): Promise<ChainResult> {
  if (!isPathInside(target, anchor)) {
    throw new EntryContainmentError(
      kind,
      target,
      "Path is outside the workspace trust anchor"
    );
  }
  let current = anchor;
  let missingSeen = false;
  for (const segment of segmentsBetween(anchor, target)) {
    current = path.join(current, segment);
    if (missingSeen) {
      // Once a parent is missing, deeper components cannot be verified.
      continue;
    }
    const state = await statDirectory(current);
    if (state === "unsafe") {
      throw new EntryContainmentError(
        kind,
        current,
        "Refusing to traverse a symlinked or non-directory path component"
      );
    }
    if (state === "missing") {
      if (!options.allowMissingTail) {
        throw new EntryContainmentError(
          kind,
          current,
          "Required directory does not exist"
        );
      }
      missingSeen = true;
      return { status: "missing", firstMissing: current };
    }
  }
  return { status: "ok" };
}

// Existing directory: the full chain including the final component must
// be a real directory.
export async function assertSafeExistingDirectory(
  anchor: string,
  target: string,
  kind: EntryContainmentErrorKind
): Promise<void> {
  await verifyContainedRealDirectoryChain(anchor, target, kind, {
    allowMissingTail: false,
  });
}

// Existing file: every parent component must be a real directory and the
// final component must be an existing regular file that is not a symlink.
export async function assertSafeExistingFile(
  anchor: string,
  target: string,
  kind: EntryContainmentErrorKind
): Promise<void> {
  await verifyContainedRealDirectoryChain(anchor, path.dirname(target), kind, {
    allowMissingTail: false,
  });
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      throw new EntryContainmentError(kind, target, "File does not exist");
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new EntryContainmentError(
      kind,
      target,
      "Path is a symlink or not a regular file"
    );
  }
}

// Async, never-throwing resolver for the entry-open path. Returns the
// absolute path only when `relativePath` is a non-absolute, lexically
// contained path that resolves through real directory components to an
// existing regular non-symlink file. Any lexical escape, missing or
// linked component, non-regular target, or lstat failure yields
// undefined. `anchor` is the entries directory (its own ancestors are
// validated when the index opens).
export async function resolveSafeExistingEntryFile(
  anchor: string,
  relativePath: string
): Promise<string | undefined> {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return undefined;
  }
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }
  const resolved = path.resolve(anchor, relativePath);
  if (!isPathInside(resolved, anchor) || resolved === path.resolve(anchor)) {
    return undefined;
  }
  try {
    await assertSafeExistingFile(anchor, resolved, "unsafe-entry");
  } catch {
    return undefined;
  }
  return resolved;
}

// Authorized-creation flow: validates the existing parent chain, then
// creates each missing component one at a time with a plain mkdir (never
// a recursive ensureDir that would silently accept a pre-existing
// symlink), lstat-ing each created component afterwards to confirm it is
// a real directory. Fails closed on any surprise.
export async function createSafeContainedDirectory(
  anchor: string,
  target: string,
  kind: EntryContainmentErrorKind
): Promise<void> {
  const chain = await verifyContainedRealDirectoryChain(anchor, target, kind, {
    allowMissingTail: true,
  });
  if (chain.status === "ok") {
    return;
  }
  let current = anchor;
  let creating = false;
  for (const segment of segmentsBetween(anchor, target)) {
    current = path.join(current, segment);
    if (!creating && current === chain.firstMissing) {
      creating = true;
    }
    if (!creating) {
      continue;
    }
    try {
      await fs.mkdir(current);
    } catch (error) {
      if (errno(error) !== "EEXIST") {
        throw new EntryContainmentError(
          kind,
          current,
          `Failed to create directory (${errno(error) ?? "unknown"})`
        );
      }
    }
    if ((await statDirectory(current)) !== "real") {
      throw new EntryContainmentError(
        kind,
        current,
        "Created path is not a real directory"
      );
    }
  }
}

// Depth-first Markdown scan that never follows a symlink or junction:
// fs.readdir's Dirent types carry raw lstat semantics, so a linked file
// or directory reports isSymbolicLink() and is skipped without a second
// stat and without being entered. Only verified real directories are
// descended and only verified regular *.md files are returned, so a
// directory-link cycle cannot recurse. Returns [] when the entries
// directory does not exist yet; throws EntryContainmentError when it
// exists but is unsafe or has an unsafe ancestor.
export async function scanContainedMarkdownFiles(
  entriesDir: string,
  anchor: string,
  ignoredDirNames: readonly string[] = []
): Promise<ScannedEntryFile[]> {
  const chain = await verifyContainedRealDirectoryChain(
    anchor,
    entriesDir,
    "unsafe-root",
    { allowMissingTail: true }
  );
  if (chain.status === "missing") {
    return [];
  }
  const ignored = new Set(ignoredDirNames);
  const found: ScannedEntryFile[] = [];
  await walkContained(entriesDir, entriesDir, ignored, found);
  return found;
}

async function walkContained(
  entriesDir: string,
  dir: string,
  ignored: Set<string>,
  found: ScannedEntryFile[]
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (dir === entriesDir) {
      // The root was just verified as a real directory; a readdir
      // failure here is unexpected -- fail closed rather than report an
      // empty journal.
      throw new EntryContainmentError(
        "unsafe-root",
        dir,
        `Failed to read the entries directory (${errno(error) ?? "unknown"})`
      );
    }
    console.error(`VS Journal: failed to read entry directory ${dir}:`, error);
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    if (entry.isDirectory()) {
      if (ignored.has(entry.name)) {
        continue;
      }
      await walkContained(
        entriesDir,
        path.join(dir, entry.name),
        ignored,
        found
      );
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    try {
      const stats = await fs.lstat(entryPath);
      if (stats.isSymbolicLink() || !stats.isFile()) {
        continue;
      }
      found.push({
        absolutePath: entryPath,
        relativePath: normalizeEntryPath(path.relative(entriesDir, entryPath)),
        mtimeMs: stats.mtimeMs,
        size: stats.size,
      });
    } catch (error) {
      console.error(`VS Journal: failed to stat entry ${entryPath}:`, error);
    }
  }
}

// Generated-state guard. Every one of entriesDir, .vs-journal, the
// database file, its quarantine copy, and the WAL/SHM sidecars must,
// where it exists, be a real directory / regular file and never a
// symlink. Missing generated files are fine -- they are created on
// demand. Called immediately before a SQLite open, before recovery, and
// again before a quarantine move/remove.
export async function assertSafeGeneratedState(
  anchor: string,
  entriesDir: string,
  generatedDir: string,
  dbPath: string
): Promise<void> {
  await assertSafeExistingDirectory(anchor, entriesDir, "unsafe-generated");
  const generatedState = await statDirectory(generatedDir);
  if (generatedState === "unsafe") {
    throw new EntryContainmentError(
      "unsafe-generated",
      generatedDir,
      "Generated index directory is a symlink or not a directory"
    );
  }
  if (generatedState === "missing") {
    return;
  }
  for (const file of [dbPath, `${dbPath}.corrupt`, `${dbPath}-wal`, `${dbPath}-shm`]) {
    await assertRegularFileOrMissing(file);
  }
}

async function assertRegularFileOrMissing(target: string): Promise<void> {
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return;
    }
    throw new EntryContainmentError(
      "unsafe-generated",
      target,
      `Could not verify generated file (${errno(error) ?? "unknown"})`
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new EntryContainmentError(
      "unsafe-generated",
      target,
      "Generated database path is a symlink or not a regular file"
    );
  }
}

// Revalidates one generated path immediately before it is moved or
// removed by recovery. Returns "safe" when the path is a regular file,
// "missing" when it is absent (nothing to do), and throws
// EntryContainmentError when it is a symlink -- the caller must not touch
// the link target.
export async function assertGeneratedFileMovable(
  target: string
): Promise<"safe" | "missing"> {
  let stats;
  try {
    stats = await fs.lstat(target);
  } catch (error) {
    if (errno(error) === "ENOENT") {
      return "missing";
    }
    throw new EntryContainmentError(
      "unsafe-generated",
      target,
      `Could not verify generated file before recovery (${errno(error) ?? "unknown"})`
    );
  }
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new EntryContainmentError(
      "unsafe-generated",
      target,
      "Refusing to move or remove a symlinked generated database path"
    );
  }
  return "safe";
}
