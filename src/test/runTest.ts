import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import { runTests } from "@vscode/test-electron";

// Prepares a disposable workspace with a journal in the default
// ./blog location so activation exercises the real database path.
async function prepareWorkspace(): Promise<string> {
  const workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "vs-journal-it-")
  );
  const entryDir = path.join(workspaceDir, "blog", "entries", "2026", "07", "24");
  await fs.ensureDir(entryDir);
  await fs.writeFile(
    path.join(entryDir, "sample.md"),
    "---\ntitle: Sample Entry\ndate: 2026-07-24 09:00:00\ntags: [integration]\n---\n\n# Sample Entry\n\nIntegration test body content.\n"
  );
  return workspaceDir;
}

async function main() {
  try {
    const extensionDevelopmentPath = path.resolve(__dirname, "../../");
    const extensionTestsPath = path.resolve(__dirname, "./suite/index");
    const workspaceDir = await prepareWorkspace();

    // VSCODE_TEST_VERSION selects the VS Code build under test
    // (e.g. "1.74.3" for the minimum supported engine, "stable" for
    // the latest release). Defaults to stable.
    const version = process.env.VSCODE_TEST_VERSION || "stable";

    await runTests({
      version,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [workspaceDir, "--disable-workspace-trust"],
    });
  } catch (error) {
    console.error("Failed to run tests:", error);
    process.exit(1);
  }
}

main();
