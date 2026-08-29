import * as vscode from "vscode";
import * as fs from "fs-extra";
import * as path from "path";
import moment = require("moment");
import { BlogIndex } from "./blogIndex";
import { SearchViewProvider } from "./searchView";
import { hasSymlinkedAncestor } from "./mediaLibrary";
import { maybeOfferGitignoreRule } from "./gitignoreGuard";
import {
  DEFAULT_MEDIA_PATH,
  createUniqueFile,
  isPathInside,
  resolveContainedMediaDir,
  toPortableBlogRelativePath,
} from "./pathUtils";

let activeHost: IndexHost | undefined;

// Resolves the configured blog directory against the first workspace
// folder, or undefined when there is no workspace or the configured
// path resolves outside it. Shared by the entry index, the file
// watcher, and the media library so the containment check lives in
// exactly one place.
function resolveBlogDir(): string | undefined {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return undefined;
  }
  const config = vscode.workspace.getConfiguration("vsJournal");
  const blogPath = config.get<string>("blogPath", "./blog");
  const blogDir = path.resolve(workspaceFolder.uri.fsPath, blogPath);
  if (!isPathInside(blogDir, workspaceFolder.uri.fsPath)) {
    return undefined;
  }
  return blogDir;
}

// Reads the configured (blog-relative) media path, defaulting to
// DEFAULT_MEDIA_PATH. Kept in one place so the command, resolution, and
// picker all agree on the fallback.
function configuredMediaPath(): string {
  return vscode.workspace
    .getConfiguration("vsJournal")
    .get<string>("mediaPath", DEFAULT_MEDIA_PATH);
}

// The media directory lives inside the configured blog directory (by
// default the "media" sibling of entries/), never created merely by
// activation -- only on first upload or another explicit media action.
// Async: beyond the (synchronous) blog-path containment check shared
// with entries, media resolution additionally (a) requires the
// configured vsJournal.mediaPath to resolve lexically inside the blog
// directory -- an absolute or escaping value yields no media directory
// at all, so an external path never reaches scanning, resource roots,
// uploads, deletion, or watchers -- and (b) rejects a symlinked
// ancestor anywhere between the workspace root and the media root.
// Both checks are explicitly scoped to media only, since upload and
// delete give an escaping or symlinked path a way to write or delete
// outside the blog that entries (read-mostly) does not have. Entry
// containment is intentionally left unchanged; it has the same latent
// gap, but fixing it is a separate, pre-existing concern outside this
// feature's scope.
async function resolveMediaDir(): Promise<string | undefined> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const blogDir = resolveBlogDir();
  if (!workspaceFolder || !blogDir) {
    return undefined;
  }
  const mediaDir = resolveContainedMediaDir(blogDir, configuredMediaPath());
  if (!mediaDir) {
    return undefined;
  }
  if (await hasSymlinkedAncestor(workspaceFolder.uri.fsPath, mediaDir)) {
    return undefined;
  }
  return mediaDir;
}

// Owns the lifecycle of the SQLite index for the configured journal:
// opens it on activation, reopens it when vsJournal.blogPath changes,
// and closes it on deactivation. All consumers reach the index through
// get()/ensure() so a reopen can never leak a stale connection.
class IndexHost {
  private index: BlogIndex | undefined;
  private opening: Promise<BlogIndex | undefined> | undefined;
  private openingCreateBlogDir = false;

  get(): BlogIndex | undefined {
    return this.index;
  }

  entriesDir(): string | undefined {
    const blogDir = resolveBlogDir();
    return blogDir ? path.join(blogDir, "entries") : undefined;
  }

  // Opens (or returns) the index for the current configuration. The
  // database is created on demand, but only once the blog directory
  // itself exists so activation never scaffolds directories into
  // workspaces that don't use the extension.
  async ensure(createBlogDir = false): Promise<BlogIndex | undefined> {
    if (this.index) {
      return this.index;
    }
    if (this.opening && createBlogDir && !this.openingCreateBlogDir) {
      // An in-flight open that started without directory creation can't
      // satisfy a caller that needs one (e.g. New Entry racing
      // activation's initializeIndex()); wait it out, then retry with
      // creation enabled instead of inheriting its undefined result.
      await this.opening;
      return this.ensure(true);
    }
    if (!this.opening) {
      this.openingCreateBlogDir = createBlogDir;
      this.opening = this.openForConfig(createBlogDir);
    }
    const opened = await this.opening;
    this.opening = undefined;
    return opened;
  }

  private async openForConfig(
    createBlogDir: boolean
  ): Promise<BlogIndex | undefined> {
    const entriesDir = this.entriesDir();
    if (!entriesDir) {
      return undefined;
    }
    const blogDir = path.dirname(entriesDir);
    if (!createBlogDir && !(await fs.pathExists(blogDir))) {
      return undefined;
    }
    try {
      await fs.ensureDir(entriesDir);
      this.index = await BlogIndex.open(entriesDir);
      return this.index;
    } catch (error) {
      console.error("VS Journal: failed to open the entry index:", error);
      vscode.window.showErrorMessage(
        `VS Journal could not open its entry index: ${error}`
      );
      return undefined;
    }
  }

  async reopen(): Promise<void> {
    const previous = this.index;
    this.index = undefined;
    this.opening = undefined;
    await previous?.close();
  }

  async dispose(): Promise<void> {
    await this.reopen();
  }
}

export function activate(context: vscode.ExtensionContext) {
  console.log("VS Journal extension is now active!");

  const host = new IndexHost();
  activeHost = host;

  // The Media library is composed into this single webview/provider
  // rather than given its own contributed view -- see the class-level
  // comment on SearchViewProvider.
  const searchView = new SearchViewProvider(
    {
      getIndex: () => host.get(),
      openEntry: (relativePath) => openEntryByRelativePath(host, relativePath),
      createNewEntry: async () => {
        await vscode.commands.executeCommand("vsJournal.newEntry");
      },
    },
    {
      getMediaDir: () => resolveMediaDir(),
      onMediaDirEnsured: () => void rebindMediaWatcher(),
    }
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SearchViewProvider.viewType,
      searchView,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Entry activity (saves, creates, deletes, rescans) must never imply a
  // media directory rescan, and vice versa -- media has its own watcher
  // and its own "ready"-handshake-triggered initial load. refreshViews()
  // combines both only where that is actually correct: a blogPath
  // change replaces both roots at once.
  function refreshEntryViews() {
    searchView.refresh();
  }

  function refreshMediaView() {
    void searchView.refreshMedia();
  }

  function refreshViews() {
    refreshEntryViews();
    refreshMediaView();
  }

  let fileWatcherDisposable: vscode.Disposable | undefined;

  function rebindFileWatcher() {
    fileWatcherDisposable?.dispose();
    fileWatcherDisposable = createFileWatcher(host, refreshEntryViews);
    if (fileWatcherDisposable) {
      context.subscriptions.push(fileWatcherDisposable);
    }
  }

  let mediaWatcherDisposable: vscode.Disposable | undefined;

  // Rebinding is safe to call repeatedly: dispose+recreate. Called on
  // activation, on a blogPath change, and after an upload that just
  // created media/ on demand -- a watcher bound before the directory
  // existed may never have started watching it.
  async function rebindMediaWatcher(): Promise<void> {
    mediaWatcherDisposable?.dispose();
    mediaWatcherDisposable = await createMediaWatcher(refreshMediaView);
    if (mediaWatcherDisposable) {
      context.subscriptions.push(mediaWatcherDisposable);
    }
  }

  const newEntryCommand = vscode.commands.registerCommand(
    "vsJournal.newEntry",
    async () => {
      await createNewEntry(host);
      refreshEntryViews();
    }
  );

  const openBlogCommand = vscode.commands.registerCommand(
    "vsJournal.openBlog",
    async () => {
      await openBlogDirectory();
    }
  );

  const refreshCommand = vscode.commands.registerCommand(
    "vsJournal.refreshEntries",
    () => {
      refreshEntryViews();
    }
  );

  // Reveals and focuses the persistent search input instead of the old
  // modal input box.
  const searchCommand = vscode.commands.registerCommand(
    "vsJournal.search",
    async () => {
      await searchView.focusSearchInput();
    }
  );

  const clearSearchCommand = vscode.commands.registerCommand(
    "vsJournal.clearSearch",
    () => {
      searchView.clear();
    }
  );

  const openEntryCommand = vscode.commands.registerCommand(
    "vsJournal.openEntry",
    async (arg?: unknown) => {
      const relativePath = extractRelativePathArg(arg);
      if (relativePath) {
        await openEntryByRelativePath(host, relativePath);
      }
    }
  );

  const searchByTagCommand = vscode.commands.registerCommand(
    "vsJournal.searchByTag",
    async (arg?: unknown) => {
      const tag = extractTagArg(arg);
      if (tag) {
        await searchView.searchByTag(tag);
      }
    }
  );

  const setBlogPathCommand = vscode.commands.registerCommand(
    "vsJournal.setBlogPath",
    async () => {
      await setBlogPath();
    }
  );

  const setMediaPathCommand = vscode.commands.registerCommand(
    "vsJournal.setMediaPath",
    async () => {
      await setMediaPath();
    }
  );

  const rescanCommand = vscode.commands.registerCommand(
    "vsJournal.rescanEntries",
    async () => {
      const index = await host.ensure();
      if (!index) {
        vscode.window.showErrorMessage(
          "No blog directory found. Create an entry or set the blog path first."
        );
        return;
      }
      await index.rebuildAll();
      refreshEntryViews();
      vscode.window.showInformationMessage(
        "Blog entries rescanned and index rebuilt!"
      );
    }
  );

  const uploadMediaCommand = vscode.commands.registerCommand(
    "vsJournal.uploadMedia",
    async () => {
      await searchView.uploadMedia();
    }
  );

  const refreshMediaLibraryCommand = vscode.commands.registerCommand(
    "vsJournal.refreshMediaLibrary",
    async () => {
      await searchView.refreshMedia();
    }
  );

  context.subscriptions.push(
    newEntryCommand,
    openBlogCommand,
    refreshCommand,
    searchCommand,
    clearSearchCommand,
    openEntryCommand,
    searchByTagCommand,
    setBlogPathCommand,
    setMediaPathCommand,
    rescanCommand,
    uploadMediaCommand,
    refreshMediaLibraryCommand
  );

  const configChangeListener = vscode.workspace.onDidChangeConfiguration(
    (e) => {
      if (e.affectsConfiguration("vsJournal.blogPath")) {
        // A blogPath change already replaces the media root too, so it
        // is handled entirely by handleBlogPathChange.
        void handleBlogPathChange();
      } else if (e.affectsConfiguration("vsJournal.mediaPath")) {
        void handleMediaPathChange();
      }
    }
  );

  async function handleBlogPathChange() {
    await host.reopen();
    await initializeIndex();
    rebindFileWatcher();
    await rebindMediaWatcher();
    searchView.clear();
    refreshViews();
    vscode.window.showInformationMessage(
      "Blog directory path updated. Views refreshed."
    );
  }

  // A mediaPath change only moves the media root: rebind the media
  // watcher and refresh the media view. The entry index, its watcher,
  // and the browse list are deliberately left untouched.
  async function handleMediaPathChange() {
    await rebindMediaWatcher();
    refreshMediaView();
  }

  context.subscriptions.push(configChangeListener);
  context.subscriptions.push({
    dispose: () => void host.dispose(),
  });

  rebindFileWatcher();
  void rebindMediaWatcher();

  // Open/create the database and reconcile it against the Markdown on
  // disk (insert new files, re-index changed ones, drop missing ones).
  async function initializeIndex() {
    const index = await host.ensure();
    if (!index) {
      refreshEntryViews();
      return;
    }
    await index.reconcile();
    refreshEntryViews();
    await maybeOfferGitignoreRule(context, index.entriesDir);
  }

  void initializeIndex();
}

async function openEntryByRelativePath(
  host: IndexHost,
  relativePath: string
): Promise<void> {
  try {
    const index = host.get();
    if (!index) {
      vscode.window.showErrorMessage("The journal index is not ready yet.");
      return;
    }
    // Containment guard: never resolve or open an indexed path outside
    // the configured entries directory.
    const absolutePath = index.resolveEntryPath(relativePath);
    if (!absolutePath) {
      vscode.window.showErrorMessage(
        `Entry path is outside the blog directory: ${relativePath}`
      );
      return;
    }
    if (!(await fs.pathExists(absolutePath))) {
      vscode.window.showErrorMessage(`Entry not found: ${relativePath}`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(absolutePath);
    await vscode.window.showTextDocument(document);
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to open entry: ${error}`);
  }
}

function extractRelativePathArg(arg: unknown): string | undefined {
  if (typeof arg === "string") {
    return arg;
  }
  if (typeof arg === "object" && arg !== null) {
    const candidate = (arg as { path?: unknown }).path;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

function extractTagArg(arg: unknown): string | undefined {
  if (typeof arg === "string") {
    return arg;
  }
  if (typeof arg === "object" && arg !== null) {
    const candidate = (arg as { tag?: unknown }).tag;
    if (typeof candidate === "string") {
      return candidate;
    }
  }
  return undefined;
}

async function setBlogPath() {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const config = vscode.workspace.getConfiguration("vsJournal");
    const currentPath = config.get<string>("blogPath", "./blog");

    const newPath = await vscode.window.showInputBox({
      prompt: "Enter the blog directory path (relative to workspace root)",
      value: currentPath,
      placeHolder: "./blog",
      validateInput: (value) => {
        if (!value || value.trim() === "") {
          return "Path cannot be empty";
        }
        // Basic validation for invalid path characters
        if (/[<>:"|?*]/.test(value)) {
          return "Path contains invalid characters";
        }
        return null;
      },
    });

    if (newPath === undefined || newPath === currentPath) {
      return; // User cancelled or no change
    }

    const fullPath = path.resolve(workspaceFolder.uri.fsPath, newPath);
    if (!isPathInside(fullPath, workspaceFolder.uri.fsPath)) {
      vscode.window.showErrorMessage(
        `Blog path must stay within the workspace: ${newPath}`
      );
      return;
    }

    await config.update(
      "blogPath",
      newPath,
      vscode.ConfigurationTarget.Workspace
    );

    if (!(await fs.pathExists(fullPath))) {
      const create = await vscode.window.showQuickPick(["Yes", "No"], {
        placeHolder: `Directory "${newPath}" doesn't exist. Create it?`,
      });

      if (create === "Yes") {
        await fs.ensureDir(path.join(fullPath, "entries"));
        vscode.window.showInformationMessage(
          `Blog directory created at: ${newPath}`
        );
      }
    }

    // The onDidChangeConfiguration listener reopens the index and
    // refreshes every view for the new location.
    vscode.window.showInformationMessage(
      `Blog directory updated to: ${newPath}`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to set blog path: ${error}`);
  }
}

// Folder-picker command for vsJournal.mediaPath. Selection is confined
// to the configured blog directory: the picker opens at the current
// valid media directory (or the blog directory), and a pick outside the
// blog is rejected with an error and leaves configuration unchanged.
// A valid pick is stored as a portable, forward-slash blog-relative
// path at Workspace scope, matching vsJournal.blogPath. Nothing here
// creates a directory -- the folder picker only selects an existing one.
async function setMediaPath() {
  try {
    const blogDir = resolveBlogDir();
    if (!blogDir) {
      vscode.window.showErrorMessage(
        "No blog directory found. Set the blog directory first."
      );
      return;
    }

    const currentMediaDir = await resolveMediaDir();
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      defaultUri: vscode.Uri.file(currentMediaDir ?? blogDir),
      openLabel: "Set Media Directory",
      title: "Select a media directory inside the blog directory",
    });

    if (!picked || picked.length === 0) {
      return; // User cancelled -- leave configuration unchanged.
    }

    const relativePath = toPortableBlogRelativePath(blogDir, picked[0].fsPath);
    if (!relativePath) {
      vscode.window.showErrorMessage(
        "The media directory must be inside the configured blog directory."
      );
      return;
    }

    // The onDidChangeConfiguration listener rebinds the media watcher
    // and refreshes the media view for the new location.
    await vscode.workspace
      .getConfiguration("vsJournal")
      .update(
        "mediaPath",
        relativePath,
        vscode.ConfigurationTarget.Workspace
      );

    vscode.window.showInformationMessage(
      `Media directory updated to: ${relativePath}`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to set media directory: ${error}`);
  }
}

async function createNewEntry(host: IndexHost) {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage(
        "No workspace folder found. Please open a workspace first."
      );
      return;
    }

    const title = await vscode.window.showInputBox({
      prompt: "Enter blog entry title",
      placeHolder: "My Blog Entry",
    });

    if (!title) {
      return;
    }

    const index = await host.ensure(true);
    if (!index) {
      vscode.window.showErrorMessage(
        "VS Journal could not open the blog directory."
      );
      return;
    }

    const now = moment();
    const entryDir = path.join(
      index.entriesDir,
      now.format("YYYY"),
      now.format("MM"),
      now.format("DD")
    );
    await fs.ensureDir(entryDir);

    const sanitizedTitle = title
      .replace(/[^a-zA-Z0-9\s]/g, "")
      .replace(/\s+/g, "-")
      .toLowerCase();
    // Punctuation-only titles sanitize to empty; fall back to a slug
    // instead of writing a bare ".md" file.
    const filenameBase = sanitizedTitle || `entry-${now.valueOf()}`;
    const filename = `${filenameBase}.md`;

    const content = `---
title: ${title}
date: ${now.format("YYYY-MM-DD HH:mm:ss")}
tags: []
---

# ${title}

Write your blog entry here...
`;

    // Exclusive create with retry, so two same-titled entries created the
    // same day never silently overwrite each other.
    const filePath = await createUniqueFile(entryDir, filename, content);
    await index.upsertFromFile(filePath);

    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document);

    vscode.window.showInformationMessage(
      `Blog entry "${title}" created successfully!`
    );
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to create blog entry: ${error}`);
  }
}

async function openBlogDirectory() {
  try {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const config = vscode.workspace.getConfiguration("vsJournal");
    const blogPath = config.get<string>("blogPath", "./blog");
    const blogDir = path.resolve(workspaceFolder.uri.fsPath, blogPath);

    if (await fs.pathExists(blogDir)) {
      const uri = vscode.Uri.file(blogDir);
      await vscode.commands.executeCommand("revealFileInOS", uri);
    } else {
      vscode.window.showErrorMessage("Blog directory not found.");
    }
  } catch (error) {
    vscode.window.showErrorMessage(`Failed to open blog directory: ${error}`);
  }
}

function createFileWatcher(
  host: IndexHost,
  refreshViews: () => void
): vscode.Disposable | undefined {
  const blogDir = resolveBlogDir();
  if (!blogDir) {
    return undefined;
  }

  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(blogDir), path.join("entries", "**", "*.md"))
  );

  async function indexFile(uri: vscode.Uri) {
    const index = await host.ensure();
    if (!index || !isPathInside(uri.fsPath, index.entriesDir)) {
      return;
    }
    try {
      await index.upsertFromFile(uri.fsPath);
      refreshViews();
    } catch (error) {
      console.error("Failed to index entry file:", error);
    }
  }

  async function dropFile(uri: vscode.Uri) {
    const index = host.get();
    if (!index || !isPathInside(uri.fsPath, index.entriesDir)) {
      return;
    }
    try {
      await index.removeByRelativePath(
        path.relative(index.entriesDir, uri.fsPath)
      );
      refreshViews();
    } catch (error) {
      console.error("Failed to remove entry from index:", error);
    }
  }

  fileWatcher.onDidChange(indexFile);
  fileWatcher.onDidCreate(indexFile);
  fileWatcher.onDidDelete(dropFile);

  // Explicit renames are treated exactly like the watcher's
  // delete+create pair: the old path is dropped, the new one indexed.
  const renameWatcher = vscode.workspace.onDidRenameFiles(async (event) => {
    for (const file of event.files) {
      if (file.oldUri.fsPath.endsWith(".md")) {
        await dropFile(file.oldUri);
      }
      if (file.newUri.fsPath.endsWith(".md")) {
        await indexFile(file.newUri);
      }
    }
  });

  const saveWatcher = vscode.workspace.onDidSaveTextDocument(
    async (document) => {
      if (
        document.languageId === "markdown" &&
        isPathInside(document.uri.fsPath, blogDir)
      ) {
        await indexFile(document.uri);
      }
    }
  );

  return vscode.Disposable.from(fileWatcher, renameWatcher, saveWatcher);
}

// Recursive watcher over the media directory. Rebound by the caller
// whenever vsJournal.blogPath changes, and again after the first
// successful upload -- a watcher created before media/ existed may
// never have started watching it, since it isn't created merely by
// activation.
async function createMediaWatcher(
  onMediaChanged: () => void
): Promise<vscode.Disposable | undefined> {
  const mediaDir = await resolveMediaDir();
  if (!mediaDir) {
    return undefined;
  }

  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(mediaDir), "**/*")
  );
  watcher.onDidCreate(onMediaChanged);
  watcher.onDidChange(onMediaChanged);
  watcher.onDidDelete(onMediaChanged);

  const renameWatcher = vscode.workspace.onDidRenameFiles((event) => {
    for (const file of event.files) {
      if (
        isPathInside(file.oldUri.fsPath, mediaDir) ||
        isPathInside(file.newUri.fsPath, mediaDir)
      ) {
        onMediaChanged();
        return;
      }
    }
  });

  return vscode.Disposable.from(watcher, renameWatcher);
}

export function deactivate(): Thenable<void> | undefined {
  const host = activeHost;
  activeHost = undefined;
  return host?.dispose();
}
