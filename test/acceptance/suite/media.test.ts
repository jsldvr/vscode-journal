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
        describeMediaLocation: () => "blog/media",
        toPortableMediaDir: () => "media",
        getEntriesDir: () => undefined,
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
        describeMediaLocation: () => "unavailable",
        toPortableMediaDir: () => "media",
        getEntriesDir: () => undefined,
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

  async function withStubbedOpenDialog<T>(
    result: vscode.Uri[] | undefined,
    run: () => Promise<T>
  ): Promise<T> {
    const original = vscode.window.showOpenDialog;
    (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog =
      async () => result;
    try {
      return await run();
    } finally {
      (vscode.window as unknown as { showOpenDialog: unknown }).showOpenDialog =
        original;
    }
  }

  async function withCapturedErrorMessages<T>(
    run: (messages: string[]) => Promise<T>
  ): Promise<T> {
    const original = vscode.window.showErrorMessage;
    const messages: string[] = [];
    (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage =
      async (message: string) => {
        messages.push(message);
        return undefined;
      };
    try {
      return await run(messages);
    } finally {
      (vscode.window as unknown as { showErrorMessage: unknown }).showErrorMessage =
        original;
    }
  }

  async function resetMediaPath(): Promise<void> {
    await vscode.workspace
      .getConfiguration("vsJournal")
      .update("mediaPath", undefined, vscode.ConfigurationTarget.Workspace);
  }

  interface CapturedCommand {
    command: string;
    args: unknown[];
  }

  // Captures vscode.commands.executeCommand calls (so revealFileInOS
  // never actually opens the OS file manager during the run) while
  // still delegating every other command to the real implementation,
  // and always restores the original in finally.
  async function withCapturedExecuteCommand<T>(
    run: (calls: CapturedCommand[]) => Promise<T>
  ): Promise<T> {
    const original = vscode.commands.executeCommand;
    const calls: CapturedCommand[] = [];
    (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
      async (command: string, ...args: unknown[]) => {
        calls.push({ command, args });
        if (command === "revealFileInOS") {
          return undefined;
        }
        return (
          original as (command: string, ...rest: unknown[]) => Thenable<unknown>
        ).call(vscode.commands, command, ...args);
      };
    try {
      return await run(calls);
    } finally {
      (vscode.commands as unknown as { executeCommand: unknown }).executeCommand =
        original;
    }
  }

  function revealedPaths(calls: CapturedCommand[]): string[] {
    return calls
      .filter((call) => call.command === "revealFileInOS")
      .map((call) => (call.args[0] as vscode.Uri).fsPath);
  }

  test("vsJournal.revealMediaDirectory is registered and contributed to the view/title overflow (non-navigation group)", async () => {
    await activateExtension();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("vsJournal.revealMediaDirectory"));

    const extension = vscode.extensions.getExtension("jsldvr.vscode-journal");
    assert.ok(extension);
    const viewTitle: Array<{ command: string; when?: string; group?: string }> =
      extension.packageJSON.contributes.menus["view/title"];
    const entry = viewTitle.find(
      (item) => item.command === "vsJournal.revealMediaDirectory"
    );
    assert.ok(entry, "reveal command must be contributed to view/title");
    assert.strictEqual(entry.when, "view == vsJournal.search");
    assert.ok(
      entry.group && !entry.group.startsWith("navigation"),
      "a non-navigation group keeps the command in the native overflow, not the title bar"
    );
  });

  test("MediaController outbound state carries the location label for populated, empty, missing, and disabled states", async () => {
    const emptyRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "vs-journal-media-loc-")
    );
    try {
      const posts: Record<string, unknown>[] = [];
      const controller = new MediaController(
        {
          getMediaDir: async () => emptyRoot,
          describeMediaLocation: () => "blog/assets",
          toPortableMediaDir: () => "assets",
          getEntriesDir: () => undefined,
          onMediaDirEnsured: () => undefined,
          requestFullRefresh: async () => undefined,
        },
        (message) => posts.push(message)
      );
      await controller.pushState();
      const filesMessage = posts.find((m) => m.type === "mediaFiles");
      assert.ok(filesMessage, "a real media root pushes mediaFiles");
      assert.strictEqual(filesMessage.location, "blog/assets");
      assert.deepStrictEqual(filesMessage.files, []);
    } finally {
      await fs.remove(emptyRoot);
    }

    // A valid but not-yet-created media directory still reports its label.
    const missingRoot = path.join(
      os.tmpdir(),
      `vs-journal-media-missing-${Date.now()}`
    );
    const missingPosts: Record<string, unknown>[] = [];
    const missingController = new MediaController(
      {
        getMediaDir: async () => missingRoot,
        describeMediaLocation: () => "blog/assets",
        toPortableMediaDir: () => "assets",
        getEntriesDir: () => undefined,
        onMediaDirEnsured: () => undefined,
        requestFullRefresh: async () => undefined,
      },
      (message) => missingPosts.push(message)
    );
    await missingController.pushState();
    const missingMessage = missingPosts.find((m) => m.type === "mediaFiles");
    assert.ok(missingMessage);
    assert.strictEqual(missingMessage.location, "blog/assets");
    assert.strictEqual(
      await fs.pathExists(missingRoot),
      false,
      "resolving a display label must not create the directory"
    );

    // A disabled (unsafe / no workspace) state still carries a label so
    // the heading never goes stale.
    const disabledPosts: Record<string, unknown>[] = [];
    const disabledController = new MediaController(
      {
        getMediaDir: async () => undefined,
        describeMediaLocation: () => "unavailable",
        toPortableMediaDir: () => "media",
        getEntriesDir: () => undefined,
        onMediaDirEnsured: () => undefined,
        requestFullRefresh: async () => undefined,
      },
      (message) => disabledPosts.push(message)
    );
    await disabledController.pushState();
    const disabledMessage = disabledPosts.find((m) => m.type === "mediaDisabled");
    assert.ok(disabledMessage);
    assert.strictEqual(disabledMessage.location, "unavailable");
  });

  test("revealMediaDirectory reveals the resolved current media directory when it exists", async () => {
    await activateExtension();
    const mediaDir = path.join(workspaceRoot(), "blog", "media");
    await fs.ensureDir(mediaDir);
    try {
      const calls = await withCapturedExecuteCommand(async (captured) => {
        await vscode.commands.executeCommand("vsJournal.revealMediaDirectory");
        return captured;
      });
      assert.deepStrictEqual(revealedPaths(calls), [mediaDir]);
    } finally {
      await fs.remove(mediaDir);
    }
  });

  test("changing vsJournal.mediaPath changes the reveal target", async () => {
    await activateExtension();
    const altDir = path.join(workspaceRoot(), "blog", "media-alt");
    await fs.ensureDir(altDir);
    try {
      await vscode.workspace
        .getConfiguration("vsJournal")
        .update("mediaPath", "media-alt", vscode.ConfigurationTarget.Workspace);
      const calls = await withCapturedExecuteCommand(async (captured) => {
        await vscode.commands.executeCommand("vsJournal.revealMediaDirectory");
        return captured;
      });
      assert.deepStrictEqual(revealedPaths(calls), [altDir]);
    } finally {
      await resetMediaPath();
      await fs.remove(altDir);
    }
  });

  test("revealMediaDirectory reports an error and reveals nothing when the media directory does not exist", async () => {
    await activateExtension();
    const mediaDir = path.join(workspaceRoot(), "blog", "media");
    await fs.remove(mediaDir);
    const errors = await withCapturedErrorMessages((messages) =>
      withCapturedExecuteCommand(async (calls) => {
        await vscode.commands.executeCommand("vsJournal.revealMediaDirectory");
        assert.deepStrictEqual(
          revealedPaths(calls),
          [],
          "a missing media directory must not be revealed"
        );
        return messages;
      })
    );
    assert.ok(
      errors.some((message) => message.includes("does not exist")),
      "a missing media directory must report a clear error"
    );
    assert.strictEqual(
      await fs.pathExists(mediaDir),
      false,
      "the reveal command must never create the media directory"
    );
  });

  test("revealMediaDirectory reports an error and reveals nothing when the media root is a plain file", async () => {
    await activateExtension();
    const mediaPath = path.join(workspaceRoot(), "blog", "media");
    await fs.remove(mediaPath);
    await fs.ensureDir(path.dirname(mediaPath));
    await fs.writeFile(mediaPath, "not a directory");
    try {
      const errors = await withCapturedErrorMessages((messages) =>
        withCapturedExecuteCommand(async (calls) => {
          await vscode.commands.executeCommand("vsJournal.revealMediaDirectory");
          assert.deepStrictEqual(revealedPaths(calls), []);
          return messages;
        })
      );
      assert.ok(errors.length > 0, "a non-directory media root must report an error");
    } finally {
      await fs.remove(mediaPath);
    }
  });

  test("revealMediaDirectory reports an error and reveals nothing when the media root is a symlink", async () => {
    await activateExtension();
    const linkPath = path.join(workspaceRoot(), "blog", "media-link");
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "vs-journal-reveal-link-target-")
    );
    try {
      const created = await trySymlinkDir(outsideDir, linkPath);
      if (!created) {
        return; // No symlink/junction support here; nothing to assert.
      }
      await vscode.workspace
        .getConfiguration("vsJournal")
        .update("mediaPath", "media-link", vscode.ConfigurationTarget.Workspace);
      const errors = await withCapturedErrorMessages((messages) =>
        withCapturedExecuteCommand(async (calls) => {
          await vscode.commands.executeCommand("vsJournal.revealMediaDirectory");
          assert.deepStrictEqual(revealedPaths(calls), []);
          return messages;
        })
      );
      assert.ok(
        errors.length > 0,
        "a symlinked media root must report an error, not be revealed"
      );
    } finally {
      await resetMediaPath();
      await fs.remove(linkPath);
      await fs.remove(outsideDir);
    }
  });

  // Directory junctions are unprivileged on Windows (unlike file
  // symlinks); still, fall back to skipping if the platform refuses.
  async function trySymlinkDir(target: string, linkPath: string): Promise<boolean> {
    try {
      await fs.symlink(target, linkPath, "junction");
      return true;
    } catch {
      return false;
    }
  }

  test("vsJournal.setMediaPath is registered and vsJournal.mediaPath defaults to media", async () => {
    await activateExtension();
    const commands = await vscode.commands.getCommands(true);
    assert.ok(commands.includes("vsJournal.setMediaPath"));
    assert.strictEqual(
      vscode.workspace.getConfiguration("vsJournal").get<string>("mediaPath"),
      "media"
    );
  });

  test("setMediaPath stores a portable, blog-relative path for a folder selected inside the blog", async () => {
    await activateExtension();
    const selectedDir = path.join(workspaceRoot(), "blog", "assets", "pics");
    await fs.ensureDir(selectedDir);
    try {
      await withStubbedOpenDialog([vscode.Uri.file(selectedDir)], () =>
        Promise.resolve(
          vscode.commands.executeCommand("vsJournal.setMediaPath")
        )
      );
      assert.strictEqual(
        vscode.workspace
          .getConfiguration("vsJournal")
          .get<string>("mediaPath"),
        "assets/pics"
      );
    } finally {
      await resetMediaPath();
      await fs.remove(path.join(workspaceRoot(), "blog", "assets"));
    }
  });

  test("setMediaPath rejects a folder outside the blog directory and leaves configuration unchanged", async () => {
    await activateExtension();
    const before = vscode.workspace
      .getConfiguration("vsJournal")
      .get<string>("mediaPath");
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "vs-journal-outside-")
    );
    try {
      const errors = await withCapturedErrorMessages((messages) =>
        withStubbedOpenDialog([vscode.Uri.file(outsideDir)], async () => {
          await vscode.commands.executeCommand("vsJournal.setMediaPath");
          return messages;
        })
      );
      assert.ok(
        errors.some((message) => message.includes("must be inside")),
        "an outside selection must report an error"
      );
      assert.strictEqual(
        vscode.workspace
          .getConfiguration("vsJournal")
          .get<string>("mediaPath"),
        before,
        "configuration must be unchanged after a rejected selection"
      );
    } finally {
      await fs.remove(outsideDir);
    }
  });

  test("setMediaPath leaves configuration unchanged when the picker is cancelled", async () => {
    await activateExtension();
    const before = vscode.workspace
      .getConfiguration("vsJournal")
      .get<string>("mediaPath");
    await withStubbedOpenDialog(undefined, () =>
      Promise.resolve(vscode.commands.executeCommand("vsJournal.setMediaPath"))
    );
    assert.strictEqual(
      vscode.workspace.getConfiguration("vsJournal").get<string>("mediaPath"),
      before
    );
  });

  test("a vsJournal.mediaPath that points at a symlinked directory yields no media directory (watcher/resource-root containment)", async () => {
    await activateExtension();
    const linkPath = path.join(workspaceRoot(), "blog", "media-link");
    const outsideDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "vs-journal-media-link-target-")
    );
    try {
      const created = await trySymlinkDir(outsideDir, linkPath);
      if (!created) {
        return; // No symlink/junction support here; nothing to assert.
      }
      await vscode.workspace
        .getConfiguration("vsJournal")
        .update(
          "mediaPath",
          "media-link",
          vscode.ConfigurationTarget.Workspace
        );

      // upload() resolves the media directory before opening its file
      // picker and reports an error when it is unavailable/unsafe. A
      // lexically-contained but symlinked root must land here rather
      // than being accepted.
      const errors = await withCapturedErrorMessages((messages) =>
        withStubbedOpenDialog(undefined, async () => {
          await vscode.commands.executeCommand("vsJournal.uploadMedia");
          return messages;
        })
      );
      assert.ok(
        errors.some((message) => message.includes("unsafe")),
        "a symlinked media root must be reported as unsafe, not accepted"
      );
    } finally {
      await resetMediaPath();
      await fs.remove(linkPath);
      await fs.remove(outsideDir);
    }
  });

  test("the media library stays functional after vsJournal.mediaPath changes, without creating the new directory", async () => {
    await activateExtension();
    try {
      await vscode.workspace
        .getConfiguration("vsJournal")
        .update(
          "mediaPath",
          "media-alt",
          vscode.ConfigurationTarget.Workspace
        );
      await vscode.commands.executeCommand("vsJournal.refreshMediaLibrary");
      assert.strictEqual(
        await fs.pathExists(path.join(workspaceRoot(), "blog", "media-alt")),
        false,
        "changing mediaPath must not scaffold the new media directory"
      );
    } finally {
      await resetMediaPath();
    }
  });

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
          describeMediaLocation: () => "blog/media",
          toPortableMediaDir: () => "media",
          getEntriesDir: () => undefined,
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

suite("Media Insertion", function () {
  this.timeout(30000);

  function entriesDir(): string {
    return path.join(workspaceRoot(), "blog", "entries");
  }

  interface InsertDepsOverrides {
    mediaDir?: string | undefined;
    portableMediaDir?: string | undefined;
    entries?: string | undefined;
  }

  function makeController(
    posts: Record<string, unknown>[],
    overrides: InsertDepsOverrides
  ): MediaController {
    return new MediaController(
      {
        getMediaDir: async () => overrides.mediaDir,
        describeMediaLocation: () => "blog/media",
        toPortableMediaDir: () =>
          "portableMediaDir" in overrides ? overrides.portableMediaDir : "media",
        getEntriesDir: () =>
          "entries" in overrides ? overrides.entries : entriesDir(),
        onMediaDirEnsured: () => undefined,
        requestFullRefresh: async () => undefined,
      },
      (message) => posts.push(message)
    );
  }

  async function makeMediaRoot(files: string[]): Promise<string> {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-insert-media-"));
    for (const name of files) {
      await fs.writeFile(path.join(root, name), "bytes");
    }
    return root;
  }

  // Opens a real file inside blog/entries/ as the active editor, runs
  // the body, then reverts and deletes it so the entry index and other
  // tests are unaffected.
  async function withActiveEntry<T>(
    relativeName: string,
    contents: string,
    run: (editor: vscode.TextEditor, filePath: string) => Promise<T>
  ): Promise<T> {
    const filePath = path.join(entriesDir(), relativeName);
    await fs.ensureDir(path.dirname(filePath));
    await fs.writeFile(filePath, contents);
    try {
      const document = await vscode.workspace.openTextDocument(filePath);
      const editor = await vscode.window.showTextDocument(document);
      return await run(editor, filePath);
    } finally {
      await vscode.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await fs.remove(filePath);
    }
  }

  function mediaDetailsTabCount(): number {
    return vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) =>
          tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType.includes("mediaDetails")
      ).length;
  }

  function lastStatus(posts: Record<string, unknown>[]): Record<string, unknown> | undefined {
    return [...posts].reverse().find((message) => message.type === "mediaStatus");
  }

  teardown(async () => {
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  });

  test("mediaInsert writes image Markdown at the cursor in an active journal entry without opening a details tab", async () => {
    await activateExtension();
    const root = await makeMediaRoot(["pic.png"]);
    try {
      await withActiveEntry("2026/08/29/insert-image.md", "# Entry\n\n", async (editor) => {
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        const posts: Record<string, unknown>[] = [];
        const controller = makeController(posts, { mediaDir: root });

        await controller.dispatch({ type: "mediaInsert", path: "pic.png" });

        assert.ok(
          editor.document.getText().includes("![alt text](media/pic.png)"),
          "the active entry must contain the image Markdown"
        );
        assert.strictEqual(mediaDetailsTabCount(), 0, "no details tab must open");
        const status = lastStatus(posts);
        assert.ok(status, "a status message must be sent");
        assert.notStrictEqual(status.isError, true, "success feedback, not an error");
      });
    } finally {
      await fs.remove(root);
    }
  });

  test("mediaInsert writes a [basename](target) link for a non-image file", async () => {
    await activateExtension();
    const root = await makeMediaRoot(["notes.pdf"]);
    try {
      await withActiveEntry("2026/08/29/insert-doc.md", "# Entry\n\n", async (editor) => {
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        const posts: Record<string, unknown>[] = [];
        const controller = makeController(posts, { mediaDir: root });

        await controller.dispatch({ type: "mediaInsert", path: "notes.pdf" });

        assert.ok(
          editor.document.getText().includes("[notes.pdf](media/notes.pdf)"),
          "the active entry must contain the non-image link"
        );
      });
    } finally {
      await fs.remove(root);
    }
  });

  test("a configured nested media directory produces an equivalent portable target", async () => {
    await activateExtension();
    const root = await makeMediaRoot(["diagram.png"]);
    try {
      await withActiveEntry("2026/08/29/insert-nested.md", "# Entry\n\n", async (editor) => {
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        const posts: Record<string, unknown>[] = [];
        const controller = makeController(posts, {
          mediaDir: root,
          portableMediaDir: "assets/uploads",
        });

        await controller.dispatch({ type: "mediaInsert", path: "diagram.png" });

        assert.ok(
          editor.document.getText().includes("![alt text](assets/uploads/diagram.png)"),
          "the target must use the configured nested media path"
        );
      });
    } finally {
      await fs.remove(root);
    }
  });

  test("a filename with spaces and parentheses is percent-encoded into a valid link", async () => {
    await activateExtension();
    const root = await makeMediaRoot(["screen shot (1).png"]);
    try {
      await withActiveEntry("2026/08/29/insert-encoded.md", "# Entry\n\n", async (editor) => {
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        const posts: Record<string, unknown>[] = [];
        const controller = makeController(posts, { mediaDir: root });

        await controller.dispatch({
          type: "mediaInsert",
          path: "screen shot (1).png",
        });

        assert.ok(
          editor.document
            .getText()
            .includes("![alt text](media/screen%20shot%20%281%29.png)"),
          "spaces and parentheses in the destination must be percent-encoded"
        );
        assert.notStrictEqual(lastStatus(posts)?.isError, true, "insertion must succeed");
      });
    } finally {
      await fs.remove(root);
    }
  });

  test("the image alt-text placeholder is selected for immediate replacement", async () => {
    await activateExtension();
    const root = await makeMediaRoot(["pic.png"]);
    try {
      await withActiveEntry("2026/08/29/insert-placeholder.md", "# Entry\n\n", async (editor) => {
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        const posts: Record<string, unknown>[] = [];
        const controller = makeController(posts, { mediaDir: root });

        await controller.dispatch({ type: "mediaInsert", path: "pic.png" });

        assert.strictEqual(
          editor.document.getText(editor.selection),
          "alt text",
          "the alt-text placeholder must be selected after insertion"
        );
      });
    } finally {
      await fs.remove(root);
    }
  });

  test("insertion is applied at every active selection", async () => {
    await activateExtension();
    const root = await makeMediaRoot(["pic.png"]);
    try {
      await withActiveEntry(
        "2026/08/29/insert-multi.md",
        "line one\nline two\nline three\n",
        async (editor) => {
          editor.selections = [
            new vscode.Selection(0, 0, 0, 0),
            new vscode.Selection(2, 0, 2, 0),
          ];
          const posts: Record<string, unknown>[] = [];
          const controller = makeController(posts, { mediaDir: root });

          await controller.dispatch({ type: "mediaInsert", path: "pic.png" });

          const occurrences = editor.document
            .getText()
            .split("![alt text](media/pic.png)").length - 1;
          assert.strictEqual(occurrences, 2, "both cursors must receive the insertion");
        }
      );
    } finally {
      await fs.remove(root);
    }
  });

  test("no active editor: mediaInsert reports an error and creates nothing", async () => {
    await activateExtension();
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    const root = await makeMediaRoot(["pic.png"]);
    try {
      const posts: Record<string, unknown>[] = [];
      const controller = makeController(posts, { mediaDir: root });

      await controller.dispatch({ type: "mediaInsert", path: "pic.png" });

      const status = lastStatus(posts);
      assert.ok(status, "a status message must be sent");
      assert.strictEqual(status.isError, true, "no active editor must be an error");
      assert.strictEqual(mediaDetailsTabCount(), 0, "no details tab must open");
    } finally {
      await fs.remove(root);
    }
  });

  test("a non-Markdown active editor is rejected without changing the document", async () => {
    await activateExtension();
    const root = await makeMediaRoot(["pic.png"]);
    try {
      await withActiveEntry("2026/08/29/insert-plain.txt", "plain text\n", async (editor) => {
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        const posts: Record<string, unknown>[] = [];
        const controller = makeController(posts, { mediaDir: root });

        await controller.dispatch({ type: "mediaInsert", path: "pic.png" });

        assert.strictEqual(editor.document.getText(), "plain text\n", "document must be unchanged");
        assert.strictEqual(lastStatus(posts)?.isError, true, "must report an error");
      });
    } finally {
      await fs.remove(root);
    }
  });

  test("a Markdown editor outside the configured entries directory is rejected", async () => {
    await activateExtension();
    const root = await makeMediaRoot(["pic.png"]);
    const outside = path.join(workspaceRoot(), "blog", "outside-entry.md");
    await fs.writeFile(outside, "# Outside\n\n");
    try {
      const document = await vscode.workspace.openTextDocument(outside);
      const editor = await vscode.window.showTextDocument(document);
      editor.selection = new vscode.Selection(2, 0, 2, 0);
      const posts: Record<string, unknown>[] = [];
      const controller = makeController(posts, { mediaDir: root });

      await controller.dispatch({ type: "mediaInsert", path: "pic.png" });

      assert.strictEqual(editor.document.getText(), "# Outside\n\n", "document must be unchanged");
      assert.strictEqual(lastStatus(posts)?.isError, true, "must report an error");
    } finally {
      await vscode.commands.executeCommand("workbench.action.closeAllEditors");
      await fs.remove(outside);
    }
  });

  test("a missing/stale media file is rejected: error, no document change, no file or directory creation, no details tab", async () => {
    await activateExtension();
    const root = await makeMediaRoot([]);
    try {
      await withActiveEntry("2026/08/29/insert-stale.md", "# Entry\n\n", async (editor) => {
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        const posts: Record<string, unknown>[] = [];
        const controller = makeController(posts, { mediaDir: root });

        await controller.dispatch({ type: "mediaInsert", path: "ghost.png" });

        assert.strictEqual(editor.document.getText(), "# Entry\n\n", "document must be unchanged");
        assert.strictEqual(lastStatus(posts)?.isError, true, "must report an error");
        assert.strictEqual(
          await fs.pathExists(path.join(root, "ghost.png")),
          false,
          "the missing media file must not be created"
        );
        assert.strictEqual(mediaDetailsTabCount(), 0, "no details tab must open");
      });
    } finally {
      await fs.remove(root);
    }
  });

  test("an unresolvable media root is rejected without changing the document", async () => {
    await activateExtension();
    try {
      await withActiveEntry("2026/08/29/insert-noroot.md", "# Entry\n\n", async (editor) => {
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        const posts: Record<string, unknown>[] = [];
        const controller = makeController(posts, { mediaDir: undefined });

        await controller.dispatch({ type: "mediaInsert", path: "pic.png" });

        assert.strictEqual(editor.document.getText(), "# Entry\n\n", "document must be unchanged");
        assert.strictEqual(lastStatus(posts)?.isError, true, "must report an error");
      });
    } finally {
      // withActiveEntry cleans up.
    }
  });

  test("primary insertion never opens the details panel, but the secondary Details action (mediaSelect) still does", async () => {
    await activateExtension();
    const root = await makeMediaRoot(["pic.png"]);
    try {
      await withActiveEntry("2026/08/29/insert-vs-details.md", "# Entry\n\n", async (editor) => {
        editor.selection = new vscode.Selection(2, 0, 2, 0);
        const posts: Record<string, unknown>[] = [];
        const controller = makeController(posts, { mediaDir: root });

        await controller.dispatch({ type: "mediaInsert", path: "pic.png" });
        assert.strictEqual(mediaDetailsTabCount(), 0, "insertion must not open a details tab");

        await controller.dispatch({ type: "mediaSelect", path: "pic.png" });
        assert.strictEqual(
          await waitFor(() => mediaDetailsTabCount() > 0, 2000),
          true,
          "the secondary Details action must still open the details panel"
        );
      });
    } finally {
      await fs.remove(root);
    }
  });
});
