import * as assert from "assert";
import * as fs from "fs-extra";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { MediaController, MediaFileWire } from "../../../src/mediaView";
import { MediaDetailsPanel } from "../../../src/mediaDetailsPanel";

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

function makeWireFile(relativePath: string): MediaFileWire {
  return {
    path: relativePath,
    name: path.basename(relativePath),
    type: "document",
    size: 1,
    mtimeMs: Date.now(),
    sizeLabel: "1 B",
  };
}

function isMediaDetailsTabActive(): boolean {
  const tab = vscode.window.tabGroups.all
    .flatMap((group) => group.tabs)
    .find(
      (candidate) =>
        candidate.input instanceof vscode.TabInputWebview &&
        candidate.input.viewType.includes("mediaDetails")
    );
  return !!tab?.isActive;
}

// panel.reveal() takes effect via async renderer-process message
// passing; tabGroups.all does not reflect it synchronously.
async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  // The three tests below exercise MediaController/MediaDetailsPanel
  // directly as plain exported classes, constructed with test-controlled
  // deps rather than through the sidebar webview's message channel --
  // there is no way to post a message into an arbitrary WebviewView's
  // own script from an Extension Host test, but these classes need
  // nothing beyond a real vscode host to run correctly, which this
  // acceptance suite already provides.

  test("background sync (syncFile/syncUnavailable) never reveals a hidden details panel; explicit selection (show/showUnavailable) does (focus-steal regression)", async () => {
    await activateExtension();
    const panel = new MediaDetailsPanel(
      () => undefined,
      () => undefined
    );
    try {
      const file = makeWireFile("photo.png");

      panel.show(file, workspaceRoot());
      assert.strictEqual(
        await waitFor(isMediaDetailsTabActive, 2000),
        true,
        "explicit show() must reveal/activate the panel"
      );

      // Move focus elsewhere so the details tab becomes hidden/inactive.
      const scratch = await vscode.workspace.openTextDocument({
        content: "scratch",
        language: "plaintext",
      });
      await vscode.window.showTextDocument(scratch);
      assert.strictEqual(
        await waitFor(() => !isMediaDetailsTabActive(), 2000),
        true,
        "test setup: the details panel must be inactive before the background-sync calls under test"
      );

      // These must NOT reveal -- there is no "becomes true" state to
      // poll for, so wait a fixed window long enough for a reveal to
      // have manifested if the regression were present, then confirm
      // it did not.
      panel.syncFile(file, workspaceRoot());
      await delay(300);
      assert.strictEqual(isMediaDetailsTabActive(), false, "syncFile() must not reveal a hidden panel");

      panel.syncUnavailable();
      await delay(300);
      assert.strictEqual(isMediaDetailsTabActive(), false, "syncUnavailable() must not reveal a hidden panel");

      panel.showUnavailable();
      assert.strictEqual(
        await waitFor(isMediaDetailsTabActive, 2000),
        true,
        "explicit showUnavailable() must still reveal the panel"
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  test("becoming unavailable clears the panel's current path, so a later file at the same path is not silently reopened (stale-selection regression)", async () => {
    await activateExtension();
    const panel = new MediaDetailsPanel(
      () => undefined,
      () => undefined
    );
    try {
      const file = makeWireFile("photo.png");

      panel.show(file, workspaceRoot());
      assert.strictEqual(panel.currentPath, "photo.png");

      panel.showUnavailable();
      assert.strictEqual(
        panel.currentPath,
        undefined,
        "currentPath must be cleared so a future scan cannot match an unrelated file landing on the same path"
      );

      // The background-sync path (syncFile/syncUnavailable) must uphold
      // the same invariant.
      panel.syncFile(file, workspaceRoot());
      assert.strictEqual(panel.currentPath, "photo.png");
      panel.syncUnavailable();
      assert.strictEqual(panel.currentPath, undefined);
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  test("MediaController.performAction reports a status error instead of letting a rejected action escape unhandled", async () => {
    const controller = new MediaController(
      {
        getMediaDir: async () => {
          throw new Error("boom");
        },
        onMediaDirEnsured: () => undefined,
        requestFullRefresh: async () => undefined,
      },
      () => undefined
    );

    const replies: Record<string, unknown>[] = [];
    await controller.performAction({ type: "mediaOpen", path: "photo.png" }, (reply) =>
      replies.push(reply)
    );

    assert.strictEqual(replies.length, 1);
    assert.strictEqual(replies[0].type, "mediaStatus");
    assert.strictEqual(replies[0].isError, true);
  });

  test("selecting a tile whose media root is unavailable still opens the details panel in its unavailable state, instead of doing nothing (unsafe-root-selection regression)", async () => {
    await activateExtension();
    const controller = new MediaController(
      {
        getMediaDir: async () => undefined,
        onMediaDirEnsured: () => undefined,
        requestFullRefresh: async () => undefined,
      },
      () => undefined
    );
    try {
      await controller.dispatch({ type: "mediaSelect", path: "photo.png" });
      assert.strictEqual(
        await waitFor(isMediaDetailsTabActive, 2000),
        true,
        "an unavailable media root must still open the details panel in its unavailable state, not silently do nothing in response to the click"
      );
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    }
  });

  async function withAutoConfirmedDelete<T>(run: () => Promise<T>): Promise<T> {
    const original = vscode.window.showWarningMessage;
    (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage =
      async () => "Delete";
    try {
      return await run();
    } finally {
      (vscode.window as unknown as { showWarningMessage: unknown }).showWarningMessage = original;
    }
  }

  test("delete aborts instead of removing a same-named file from a different blog root if the media root changes while the confirmation modal is open (cross-root-delete regression)", async () => {
    const rootA = await fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-media-a-"));
    const rootB = await fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-media-b-"));
    try {
      await fs.writeFile(path.join(rootA, "photo.png"), "a-content");
      await fs.writeFile(path.join(rootB, "photo.png"), "b-content");

      // Simulates vsJournal.blogPath changing to an unrelated blog while
      // the "Delete?" modal is open: the pre-modal lookup resolves
      // against rootA, but the post-modal revalidation sees rootB.
      let calls = 0;
      const controller = new MediaController(
        {
          getMediaDir: async () => (calls++ === 0 ? rootA : rootB),
          onMediaDirEnsured: () => undefined,
          requestFullRefresh: async () => undefined,
        },
        () => undefined
      );

      const replies: Record<string, unknown>[] = [];
      await withAutoConfirmedDelete(() =>
        controller.performAction({ type: "mediaDelete", path: "photo.png" }, (reply) =>
          replies.push(reply)
        )
      );

      assert.strictEqual(replies.length, 1);
      assert.strictEqual(replies[0].type, "mediaStatus");
      assert.strictEqual(replies[0].isError, true);
      assert.strictEqual(
        await fs.pathExists(path.join(rootA, "photo.png")),
        true,
        "the file under the original (pre-modal) root must survive"
      );
      assert.strictEqual(
        await fs.pathExists(path.join(rootB, "photo.png")),
        true,
        "the same-named file under the new (post-modal) root must not be touched either"
      );
    } finally {
      await fs.remove(rootA);
      await fs.remove(rootB);
    }
  });
});
