import * as fs from "fs-extra";
import * as path from "path";
import { GENERATED_DIR_NAME } from "./blogIndex";

// The rule appended to a workspace .gitignore. The whole generated
// directory is ignored (rather than individual filenames) so the
// database, -wal/-shm sidecars, quarantined .corrupt backups, and any
// future generated files are all covered at any journal depth.
export const GITIGNORE_RULE = `**/${GENERATED_DIR_NAME}/`;

// Pure matcher used when git is unavailable: does this .gitignore
// content already cover the generated directory? Recognizes the common
// spellings; anything more exotic falls back to `git check-ignore`.
export function gitignoreCoversGeneratedDir(content: string): boolean {
  const candidates = new Set([
    GENERATED_DIR_NAME,
    `${GENERATED_DIR_NAME}/`,
    `/${GENERATED_DIR_NAME}`,
    `/${GENERATED_DIR_NAME}/`,
    `**/${GENERATED_DIR_NAME}`,
    `**/${GENERATED_DIR_NAME}/`,
  ]);
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .some((line) => candidates.has(line));
}

export function findGitRoot(startDir: string): string | undefined {
  let current = startDir;
  for (;;) {
    if (fs.existsSync(path.join(current, ".git"))) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

// Appends the ignore rule without duplicating an existing one and
// without touching any other line.
export async function appendGitignoreRule(gitignorePath: string): Promise<void> {
  const existing = (await fs.pathExists(gitignorePath))
    ? await fs.readFile(gitignorePath, "utf8")
    : "";
  if (gitignoreCoversGeneratedDir(existing)) {
    return;
  }
  const separator =
    existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await fs.writeFile(
    gitignorePath,
    `${existing}${separator}${GITIGNORE_RULE}\n`
  );
}
