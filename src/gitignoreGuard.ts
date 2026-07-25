import * as vscode from "vscode";
import * as fs from "fs-extra";
import * as path from "path";
import { execFile } from "child_process";
import { GENERATED_DIR_NAME } from "./blogIndex";
import {
  GITIGNORE_RULE,
  appendGitignoreRule,
  findGitRoot,
  gitignoreCoversGeneratedDir,
} from "./gitignoreCore";

const OFFER_STATE_PREFIX = "vsJournal.gitignoreOffered:";

function runGit(
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 5000 }, (error, stdout) => {
      const code =
        error && typeof (error as { code?: unknown }).code === "number"
          ? ((error as { code?: number }).code as number)
          : error
          ? -1
          : 0;
      resolve({ code, stdout: stdout ?? "" });
    });
  });
}

async function isIgnoredByGit(
  gitRoot: string,
  generatedDir: string
): Promise<boolean | undefined> {
  const probe = path.join(generatedDir, "probe");
  const result = await runGit(["check-ignore", "-q", "--", probe], gitRoot);
  if (result.code === 0) {
    return true;
  }
  if (result.code === 1) {
    return false;
  }
  // git missing or errored: undecided, fall back to reading .gitignore.
  return undefined;
}

async function isTrackedByGit(
  gitRoot: string,
  generatedDir: string
): Promise<boolean> {
  const result = await runGit(
    ["ls-files", "--cached", "--", generatedDir],
    gitRoot
  );
  return result.code === 0 && result.stdout.trim().length > 0;
}

async function generatedDirIsIgnored(
  gitRoot: string,
  generatedDir: string
): Promise<boolean> {
  const byGit = await isIgnoredByGit(gitRoot, generatedDir);
  if (byGit !== undefined) {
    return byGit;
  }
  const gitignorePath = path.join(gitRoot, ".gitignore");
  if (!(await fs.pathExists(gitignorePath))) {
    return false;
  }
  return gitignoreCoversGeneratedDir(await fs.readFile(gitignorePath, "utf8"));
}

// One-time workspace offer: if the journal lives inside a git
// repository whose ignore rules do not cover .vs-journal/, ask once
// whether to add the rule to that repository's root .gitignore. The
// file is modified only after the user explicitly chooses the action.
export async function maybeOfferGitignoreRule(
  context: vscode.ExtensionContext,
  entriesDir: string
): Promise<void> {
  const generatedDir = path.join(entriesDir, GENERATED_DIR_NAME);
  const gitRoot = findGitRoot(entriesDir);
  if (!gitRoot) {
    return;
  }
  const stateKey = `${OFFER_STATE_PREFIX}${gitRoot}`;
  if (context.workspaceState.get<boolean>(stateKey)) {
    return;
  }
  if (await generatedDirIsIgnored(gitRoot, generatedDir)) {
    return;
  }

  const addAction = "Add to .gitignore";
  const choice = await vscode.window.showInformationMessage(
    `VS Journal keeps a rebuildable search index in "${GENERATED_DIR_NAME}/" inside your journal. ` +
      `Add "${GITIGNORE_RULE}" to this repository's .gitignore so it is not committed?`,
    addAction,
    "Not Now"
  );
  await context.workspaceState.update(stateKey, true);
  if (choice !== addAction) {
    return;
  }

  await appendGitignoreRule(path.join(gitRoot, ".gitignore"));
  if (await isTrackedByGit(gitRoot, generatedDir)) {
    vscode.window.showWarningMessage(
      `"${GENERATED_DIR_NAME}/" files are already tracked or staged in git. ` +
        "The new ignore rule will not untrack them; untrack them manually " +
        `(for example: git rm -r --cached "${GENERATED_DIR_NAME}").`
    );
    return;
  }
  vscode.window.showInformationMessage(
    `Added "${GITIGNORE_RULE}" to ${path.join(gitRoot, ".gitignore")}.`
  );
}
