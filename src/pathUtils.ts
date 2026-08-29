import * as fs from "fs-extra";
import * as path from "path";
import { constants as fsConstants } from "fs";

const MAX_FILENAME_ATTEMPTS = 1000;

// Runtime fallback for vsJournal.mediaPath, mirroring the manifest
// default so a missing or blank configuration value resolves to the
// same blog-relative subdirectory the extension has always used.
export const DEFAULT_MEDIA_PATH = "media";

export function normalizeEntryPath(entryPath: string): string {
  return entryPath.replace(/\\/g, "/");
}

// True when `child` resolves to a directory strictly below `base` --
// excluding `base` itself and anything reached by traversal. Unlike a
// bare `relative.startsWith("..")` test, an ordinary contained
// directory whose own name begins with two dots (relative "..assets")
// is kept, while real traversal ("..", "../x") and absolute relatives
// are rejected. On case-insensitive filesystems path.relative()
// normalizes casing, so a case-only variant of `base` collapses to ""
// and is treated as `base` itself.
function isStrictlyInside(base: string, child: string): boolean {
  const relative = path.relative(base, child);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(".." + path.sep) &&
    !path.isAbsolute(relative)
  );
}

// Resolves the configured (blog-relative) media path against blogDir,
// returning the absolute media directory only when it stays lexically
// inside blogDir and is not blogDir itself. A blank value falls back to
// DEFAULT_MEDIA_PATH; an absolute value, a traversal that escapes the
// blog, or a value that resolves to the blog root all yield undefined
// so callers can refuse to expose a media root rather than silently
// operating on the blog directory or somewhere outside it. This is only
// the lexical-containment gate; media-specific symlink checks are
// applied by the caller after this succeeds.
export function resolveContainedMediaDir(
  blogDir: string,
  mediaPath: string | undefined
): string | undefined {
  const configured = (mediaPath ?? "").trim() || DEFAULT_MEDIA_PATH;
  if (path.isAbsolute(configured)) {
    return undefined;
  }
  const resolved = path.resolve(blogDir, configured);
  if (!isStrictlyInside(blogDir, resolved)) {
    return undefined;
  }
  return resolved;
}

// Converts an absolute directory selection into the portable,
// forward-slash blog-relative form stored in vsJournal.mediaPath.
// Returns undefined when the selection is blogDir itself or is not
// lexically contained within blogDir, so an outside pick can never be
// written to configuration.
export function toPortableBlogRelativePath(
  blogDir: string,
  selectedDir: string
): string | undefined {
  if (!isStrictlyInside(blogDir, selectedDir)) {
    return undefined;
  }
  return normalizeEntryPath(path.relative(blogDir, selectedDir));
}

// Formats an absolute directory as a display label relative to
// workspaceRoot, using forward slashes (e.g. "blog/assets"). Returns
// undefined when dir is workspaceRoot itself or is not lexically
// contained within it, so callers can fall back to an "unavailable"
// label rather than ever surfacing an absolute filesystem path. Uses
// the same boundary-aware containment check as resolveContainedMediaDir
// so a legitimately contained directory whose own name begins with two
// dots (e.g. "..assets") is labelled, not rejected as traversal. This
// is presentation only -- it performs no filesystem access and implies
// nothing about whether dir exists.
export function toWorkspaceRelativeDisplayPath(
  workspaceRoot: string,
  dir: string
): string | undefined {
  if (!isStrictlyInside(workspaceRoot, dir)) {
    return undefined;
  }
  return normalizeEntryPath(path.relative(workspaceRoot, dir));
}

export function isPathInside(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

export async function createUniqueFile(
  dir: string,
  filename: string,
  content: string
): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  for (let attempt = 1; attempt <= MAX_FILENAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? filename : `${base}-${attempt}${ext}`;
    const candidatePath = path.join(dir, candidate);

    try {
      await fs.writeFile(candidatePath, content, { flag: "wx" });
      return candidatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error(
    `Could not allocate a unique filename for "${filename}" after ${MAX_FILENAME_ATTEMPTS} attempts.`
  );
}

// Exclusive copy with retry, mirroring createUniqueFile's naming scheme
// (name-2.ext, name-3.ext, ...) but for copying an existing source file
// instead of writing string content. COPYFILE_EXCL makes each attempt
// atomic so two concurrent imports of the same filename can never race
// into an overwrite -- one wins the name, the other retries the next
// candidate.
export async function createUniqueCopy(
  dir: string,
  filename: string,
  sourcePath: string
): Promise<string> {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);

  for (let attempt = 1; attempt <= MAX_FILENAME_ATTEMPTS; attempt++) {
    const candidate = attempt === 1 ? filename : `${base}-${attempt}${ext}`;
    const candidatePath = path.join(dir, candidate);

    try {
      await fs.copyFile(sourcePath, candidatePath, fsConstants.COPYFILE_EXCL);
      return candidatePath;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw error;
      }
    }
  }

  throw new Error(
    `Could not allocate a unique filename for "${filename}" after ${MAX_FILENAME_ATTEMPTS} attempts.`
  );
}
