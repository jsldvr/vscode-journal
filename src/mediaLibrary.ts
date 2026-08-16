// Filesystem-backed media library: classification, recursive scanning,
// sorting, search/type filtering, collision-safe import, and the
// containment gate every open/reveal/copy/delete action must pass
// through. Kept free of vscode imports so the unit suite can exercise
// it directly against real temp directories.

import * as fs from "fs-extra";
import * as path from "path";
import { Dirent } from "fs";
import { createUniqueCopy, isPathInside, normalizeEntryPath } from "./pathUtils";
import { MediaFile, MediaType } from "./types";

const IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
  ".avif",
  ".ico",
]);

const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".m4a",
  ".flac",
  ".aac",
  ".weba",
]);

const VIDEO_EXTENSIONS = new Set([
  ".mp4",
  ".webm",
  ".ogv",
  ".mov",
  ".m4v",
]);

// PDFs and everything else (including unrecognized extensions) fall
// back to "document" so unknown files stay manageable through a
// generic placeholder instead of disappearing from the library.
export function classifyMediaType(filename: string): MediaType {
  const ext = path.extname(filename).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) {
    return "image";
  }
  if (AUDIO_EXTENSIONS.has(ext)) {
    return "audio";
  }
  if (VIDEO_EXTENSIONS.has(ext)) {
    return "video";
  }
  return "document";
}

// Sorted newest-modified-first, with relative path as a deterministic
// tie-breaker so equal-mtime files always render in the same order.
export function sortMediaFiles(files: MediaFile[]): MediaFile[] {
  return [...files].sort((a, b) => {
    if (a.mtimeMs !== b.mtimeMs) {
      return b.mtimeMs - a.mtimeMs;
    }
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });
}

type MediaRootState = "missing" | "real-directory" | "unsafe";

// The recursive symlink guard (hasSymlinkInPath) only ever inspects
// descendants of mediaRoot -- it starts walking from mediaRoot's own
// children, so a mediaRoot that is *itself* a symlink (e.g. blog/media
// pre-created to point outside the blog) was previously never checked
// and would be followed by fs.readdir/fs.ensureDir. Every entry point
// (scan, resolve, import) must check the root itself first.
async function statMediaRoot(mediaRoot: string): Promise<MediaRootState> {
  let stats;
  try {
    stats = await fs.lstat(mediaRoot);
  } catch (error) {
    // Only "doesn't exist yet" is the normal not-yet-created state.
    // Permission errors and anything else must propagate so the UI
    // reports a load failure instead of a false empty library.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    return "unsafe";
  }
  return "real-directory";
}

function unsafeMediaRootError(mediaRoot: string): Error {
  return new Error(
    `Media directory must be a real directory, not a symlink: ${mediaRoot}`
  );
}

// Whether mediaRoot is currently safe to grant as a webview resource
// root (localResourceRoots). Deliberately never throws -- unlike
// scanMediaDirectory/resolveContainedMediaFilePath, which throw/reject
// on uncertainty so a data-loading failure surfaces loudly, granting
// resource-serving access is the more dangerous default, so any
// uncertainty here (including a stat error) resolves to "not safe"
// rather than propagating. This is the single source of truth for
// "may this path be exposed to the webview," independent of whether
// mediaRoot currently has any files in it.
export async function isMediaRootDirectory(mediaRoot: string): Promise<boolean> {
  try {
    return (await statMediaRoot(mediaRoot)) === "real-directory";
  } catch {
    return false;
  }
}

// Recursively scans mediaRoot for regular files. Symlinks -- whether a
// symlinked file or a symlinked directory -- are excluded from both
// traversal and results without being followed: fs.readdir's Dirent
// entries reflect the raw directory-entry type (lstat semantics), so a
// symlink is reported as isSymbolicLink() rather than isFile()/
// isDirectory() without any extra stat call. Individual entries that
// fail to stat (removed mid-scan, permission denied, etc.) are skipped
// rather than aborting the whole scan. A missing mediaRoot is the
// normal not-yet-created empty-library state ([]); a mediaRoot that
// exists but is a symlink is a safety violation and throws instead of
// silently reporting an empty library.
export async function scanMediaDirectory(mediaRoot: string): Promise<MediaFile[]> {
  const state = await statMediaRoot(mediaRoot);
  if (state === "missing") {
    return [];
  }
  if (state === "unsafe") {
    throw unsafeMediaRootError(mediaRoot);
  }

  const results: MediaFile[] = [];
  await walk(mediaRoot, mediaRoot, results);
  return sortMediaFiles(results);
}

async function walk(
  mediaRoot: string,
  dir: string,
  results: MediaFile[]
): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    console.error(`VS Journal: failed to read media directory ${dir}:`, error);
    return;
  }

  for (const entry of entries) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(mediaRoot, entryPath, results);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    try {
      const stats = await fs.lstat(entryPath);
      if (!stats.isFile()) {
        continue;
      }
      const relativePath = normalizeEntryPath(path.relative(mediaRoot, entryPath));
      results.push({
        path: relativePath,
        name: entry.name,
        type: classifyMediaType(entry.name),
        size: stats.size,
        mtimeMs: stats.mtimeMs,
      });
    } catch (error) {
      console.error(`VS Journal: failed to stat media file ${entryPath}:`, error);
    }
  }
}

export interface MediaFilterOptions {
  query?: string;
  type?: MediaType | "all";
}

// Case-insensitive substring match against filename and media-relative
// path, plus an optional type filter. Pure so both the extension host
// and (in mirrored form) the webview script can apply identical
// semantics without a round trip per keystroke.
export function filterMediaFiles(
  files: MediaFile[],
  options: MediaFilterOptions
): MediaFile[] {
  const query = (options.query ?? "").trim().toLowerCase();
  const type = options.type ?? "all";
  return files.filter((file) => {
    if (type !== "all" && file.type !== type) {
      return false;
    }
    if (query.length === 0) {
      return true;
    }
    return (
      file.name.toLowerCase().includes(query) ||
      file.path.toLowerCase().includes(query)
    );
  });
}

// Walks every path segment from mediaRoot down to (and including)
// target, lstat-ing each one. isPathInside only proves lexical
// containment of the final resolved string; a symlinked intermediate
// directory (e.g. media/link -> ../../outside) can lexically resolve
// inside mediaRoot while the real file lives elsewhere, so every
// segment must be individually verified not to be a symlink.
async function hasSymlinkInPath(root: string, target: string): Promise<boolean> {
  const relative = path.relative(root, target);
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch {
      return true;
    }
    if (stats.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

// Media-specific guard, checked separately from entry containment:
// walks every path segment from workspaceRoot down to (but not
// including) mediaRoot itself -- e.g. the blog directory, or any
// directory between the workspace root and the blog -- lstat-ing each
// one. mediaRoot's own symlink-ness is already covered by
// statMediaRoot; this covers a symlinked ancestor higher up the chain,
// which upload and delete would otherwise silently write through or
// delete through. Fails closed: only ENOENT (the ancestor, and
// therefore mediaRoot, doesn't exist yet -- the normal lazy-creation
// state, which statMediaRoot's "missing" state handles separately) is
// treated as "no symlink here." Any other lstat error (permission,
// I/O, unexpected) is treated as unsafe rather than silently
// continuing, since the ancestor cannot actually be verified as a real
// directory.
export async function hasSymlinkedAncestor(
  workspaceRoot: string,
  mediaRoot: string
): Promise<boolean> {
  const relative = path.relative(workspaceRoot, mediaRoot);
  const segments = relative.split(path.sep).filter((segment) => segment.length > 0);
  segments.pop(); // mediaRoot itself is checked separately by statMediaRoot
  let current = workspaceRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stats;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      return true;
    }
    if (stats.isSymbolicLink()) {
      return true;
    }
  }
  return false;
}

// The single containment gate every open/reveal/copy-path/delete
// action must pass through: rejects absolute paths, a mediaRoot that
// is itself a symlink, traversal outside mediaRoot, any symlinked path
// segment, and anything that isn't a regular file. Returns the
// resolved absolute path only when every check passes. Safe to call
// twice in a row for the same relativePath (callers re-validate
// immediately before an irreversible action like delete): a stable
// target returns the identical resolved path both times.
export async function resolveContainedMediaFilePath(
  mediaRoot: string,
  relativePath: string
): Promise<string | undefined> {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    return undefined;
  }
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }
  if ((await statMediaRoot(mediaRoot)) !== "real-directory") {
    return undefined;
  }
  const resolved = path.resolve(mediaRoot, relativePath);
  if (!isPathInside(resolved, mediaRoot)) {
    return undefined;
  }
  if (await hasSymlinkInPath(mediaRoot, resolved)) {
    return undefined;
  }
  try {
    const stats = await fs.lstat(resolved);
    if (!stats.isFile()) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return resolved;
}

export interface ImportResult {
  path: string; // media-relative, forward-slash
  absolutePath: string;
}

// Creates mediaRoot on demand and copies sourcePath into it under its
// original filename, using createUniqueCopy for collision-safe,
// overwrite-free naming (name-2.ext, name-3.ext, ...). Upload never
// takes a caller-supplied subdirectory, so the copy always lands
// directly under mediaRoot -- there is no relative-path input to
// validate here. Refuses to write through a pre-existing symlinked
// mediaRoot: fs.ensureDir treats an existing symlink-to-directory as
// already satisfied and would otherwise follow it silently.
export async function importMediaFile(
  mediaRoot: string,
  sourcePath: string,
  filename: string
): Promise<ImportResult> {
  if ((await statMediaRoot(mediaRoot)) === "unsafe") {
    throw unsafeMediaRootError(mediaRoot);
  }
  await fs.ensureDir(mediaRoot);
  const absolutePath = await createUniqueCopy(mediaRoot, filename, sourcePath);
  return {
    path: normalizeEntryPath(path.relative(mediaRoot, absolutePath)),
    absolutePath,
  };
}

const SIZE_UNITS = ["B", "KB", "MB", "GB", "TB"];

// Human-readable byte formatting: whole bytes are shown without a
// decimal, everything above 1 KB gets one decimal place.
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < SIZE_UNITS.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${SIZE_UNITS[unitIndex]}`;
}
