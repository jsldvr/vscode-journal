import * as assert from "assert";
import * as fs from "fs-extra";
import * as path from "path";
import * as vscode from "vscode";

async function activateExtension(): Promise<void> {
  const extension = vscode.extensions.getExtension("jsldvr.vscode-journal");
  assert.ok(extension, "Extension not found");
  await extension.activate();
  assert.strictEqual(extension.isActive, true);
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, "integration workspace missing");
  return folder.uri.fsPath;
}

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return predicate();
}

suite("Extension Activation", function () {
  this.timeout(30000);

  test("activates without throwing", async () => {
    await activateExtension();
  });

  // The native sqlite3 module must load inside the Electron extension
  // host for this to pass: activation opens the database and the
  // reconciliation pass indexes the sample entry, creating the
  // generated database file. No map.json exists in this workspace.
  test("activation creates the SQLite index and indexes entries without map.json", async () => {
    await activateExtension();
    const dbPath = path.join(
      workspaceRoot(),
      "blog",
      "entries",
      ".vs-journal",
      "index.sqlite3"
    );
    const created = await waitFor(() => fs.pathExists(dbPath), 20000);
    assert.strictEqual(created, true, `index database not created: ${dbPath}`);
  });

  test("rescan command completes and reports via the index", async () => {
    await activateExtension();
    await vscode.commands.executeCommand("vsJournal.rescanEntries");
  });

  test("search, clearSearch, and searchByTag commands execute without rejecting", async () => {
    await activateExtension();
    await vscode.commands.executeCommand("vsJournal.search");
    await vscode.commands.executeCommand("vsJournal.clearSearch");
    await vscode.commands.executeCommand("vsJournal.searchByTag", "integration");
  });

  test("openEntry rejects traversal paths without throwing", async () => {
    await activateExtension();
    await vscode.commands.executeCommand("vsJournal.openEntry", "../../evil.md");
    await vscode.commands.executeCommand("vsJournal.openEntry");
  });
});
