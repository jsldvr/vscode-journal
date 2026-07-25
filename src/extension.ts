import * as vscode from "vscode";
import * as fs from "fs-extra";
import * as path from "path";
import * as moment from "moment";
import { BlogIndex } from "./blogIndex";
import { SearchViewProvider } from "./searchView";
import { maybeOfferGitignoreRule } from "./gitignoreGuard";
import { createUniqueFile, isPathInside } from "./pathUtils";

let activeHost: IndexHost | undefined;

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
    return path.join(blogDir, "entries");
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

  const searchView = new SearchViewProvider({
    getIndex: () => host.get(),
    openEntry: (relativePath) => openEntryByRelativePath(host, relativePath),
    createNewEntry: async () => {
      await vscode.commands.executeCommand("vsJournal.newEntry");
    },
  });

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SearchViewProvider.viewType,
      searchView,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  function refreshViews() {
    searchView.refresh();
  }

  let fileWatcherDisposable: vscode.Disposable | undefined;

  function rebindFileWatcher() {
    fileWatcherDisposable?.dispose();
    fileWatcherDisposable = createFileWatcher(host, refreshViews);
    if (fileWatcherDisposable) {
      context.subscriptions.push(fileWatcherDisposable);
    }
  }

  const newEntryCommand = vscode.commands.registerCommand(
    "vsJournal.newEntry",
    async () => {
      await createNewEntry(host);
      refreshViews();
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
      refreshViews();
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
      refreshViews();
      vscode.window.showInformationMessage(
        "Blog entries rescanned and index rebuilt!"
      );
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
    rescanCommand
  );

  const configChangeListener = vscode.workspace.onDidChangeConfiguration(
    (e) => {
      if (e.affectsConfiguration("vsJournal.blogPath")) {
        void handleBlogPathChange();
      }
    }
  );

  async function handleBlogPathChange() {
    await host.reopen();
    await initializeIndex();
    rebindFileWatcher();
    searchView.clear();
    refreshViews();
    vscode.window.showInformationMessage(
      "Blog directory path updated. Views refreshed."
    );
  }

  context.subscriptions.push(configChangeListener);
  context.subscriptions.push({
    dispose: () => void host.dispose(),
  });

  rebindFileWatcher();

  // Open/create the database and reconcile it against the Markdown on
  // disk (insert new files, re-index changed ones, drop missing ones).
  async function initializeIndex() {
    const index = await host.ensure();
    if (!index) {
      refreshViews();
      return;
    }
    await index.reconcile();
    refreshViews();
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
  const blogPattern = path.join(blogPath, "entries", "**", "*.md");

  const fileWatcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(workspaceFolder, blogPattern)
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

export function deactivate(): Thenable<void> | undefined {
  const host = activeHost;
  activeHost = undefined;
  return host?.dispose();
}
