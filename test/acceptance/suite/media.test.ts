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

suite("Media Library", function () {
  this.timeout(30000);

  test("there is exactly one contributed Journal view -- no separate vsJournal.media view exists, and it remains functional", async () => {
    await activateExtension();
    // VS Code auto-generates a "<viewId>.focus" command for every
    // contributed view. Media is composed into the single vsJournal.search
    // webview rather than given its own contributed view, so no
    // "vsJournal.media.focus" command should exist at all.
    const commands = await vscode.commands.getCommands(true);
    assert.strictEqual(
      commands.includes("vsJournal.media.focus"),
      false,
      "vsJournal.media must not be a separately contributed view"
    );
    await assert.rejects(() =>
      Promise.resolve(vscode.commands.executeCommand("vsJournal.media.focus"))
    );

    // The existing Journal view (which now also hosts the Media section)
    // must still be registered and focusable.
    assert.ok(commands.includes("vsJournal.search.focus"));
    await vscode.commands.executeCommand("vsJournal.search.focus");
  });

  test("activation does not create blog/media -- it is created lazily on first upload", async () => {
    await activateExtension();
    const mediaDir = path.join(workspaceRoot(), "blog", "media");
    assert.strictEqual(
      await fs.pathExists(mediaDir),
      false,
      "blog/media must not be scaffolded by activation alone"
    );
  });

  test("uploadMedia and refreshMediaLibrary commands are registered", async () => {
    await activateExtension();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("vsJournal.uploadMedia"));
    assert.ok(commands.includes("vsJournal.refreshMediaLibrary"));
  });

  test("refreshMediaLibrary executes without throwing against an empty/missing media directory", async () => {
    await activateExtension();
    await vscode.commands.executeCommand("vsJournal.refreshMediaLibrary");
  });

  test("changing vsJournal.blogPath does not break the media view or existing entry behavior", async () => {
    await activateExtension();
    const config = vscode.workspace.getConfiguration("vsJournal");
    const originalPath = config.get<string>("blogPath", "./blog");
    try {
      await config.update("blogPath", "./blog2", vscode.ConfigurationTarget.Workspace);
      await vscode.commands.executeCommand("vsJournal.refreshMediaLibrary");
      await vscode.commands.executeCommand("vsJournal.rescanEntries");
    } finally {
      await config.update("blogPath", originalPath, vscode.ConfigurationTarget.Workspace);
    }
  });

  test("no media details editor panel opens merely from activation, focusing the view, or refreshing", async () => {
    await activateExtension();
    await vscode.commands.executeCommand("vsJournal.search.focus");
    await vscode.commands.executeCommand("vsJournal.refreshMediaLibrary");

    // The details panel is an editor-area vscode.WebviewPanel, which
    // shows up in tabGroups regardless of visibility; it must only ever
    // be created in response to an explicit tile selection, never as a
    // side effect of activation, focusing the sidebar, or refreshing.
    const detailsTabs = vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.includes("mediaDetails")
      );
    assert.strictEqual(
      detailsTabs.length,
      0,
      "no media details editor panel should exist without an explicit tile selection"
    );
  });
});
