import * as fs from "fs-extra";
import * as path from "path";

const MAX_FILENAME_ATTEMPTS = 1000;

export function normalizeEntryPath(entryPath: string): string {
  return entryPath.replace(/\\/g, "/");
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
