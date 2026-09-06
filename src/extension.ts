import * as vscode from "vscode";
import * as fs from "fs-extra";
import * as path from "path";
import moment = require("moment");
import { BlogIndex } from "./blogIndex";
import {
  EntryContainmentError,
  assertSafeExistingDirectory,
  assertSafeExistingFile,
  createSafeContainedDirectory,
  verifyContainedRealDirectoryChain,
} from "./entryContainment";
import { IndexLifecycle } from "./indexLifecycle";
import { SearchViewProvider } from "./searchView";
import {
  hasSymlinkedAncestor,
  isMediaRootDirectory,
  isMediaRootWatchable,
} from "./mediaLibrary";
import { maybeOfferGitignoreRule } from "./gitignoreGuard";
import {
  DEFAULT_MEDIA_PATH,
  createUniqueFile,
  isPathInside,
  resolveContainedMediaDir,
  toPortableBlogRelativePath,
  toWorkspaceRelativeDisplayPath,
} from "./pathUtils";

// Shown in the Media heading and by the reveal command when no safe
// media target can be resolved.
const MEDIA_LOCATION_UNAVAILABLE = "unavailable";

let activeHost: IndexHost | undefined;

// Resolves the configured blog directory against the first workspace
// folder, or undefined when there is no workspace or the configured
// path resolves outside it. Shared by the entry index, the file
// watcher, and the media library so the containment check lives in
// exactly one place.
// The workspace trust anchor: the first workspace folder's path. Every
// entry/generated path is required to be lexically contained below this
// and reachable only through real, non-symlink directory components.
function workspaceTrustAnchor(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

// Maps an EntryContainmentError to a concise, actionable message that
// distinguishes an unsafe configured journal root, an unsafe entry path,
// and an unsafe generated database path, without leaking a stack trace.
function describeContainmentError(error: EntryContainmentError): string {
  switch (error.kind) {
    case "unsafe-root":
      return "The configured journal directory is not safe: it, or a directory above it, is a symlink or junction. Update vsJournal.blogPath to a real directory inside the workspace.";
    case "unsafe-generated":
      return "The generated journal index path is not safe: index.sqlite3, its .vs-journal directory, or a sidecar is a symlink or junction. Remove the link so the index can be rebuilt.";
    default:
      return "That entry path is not safe: it, or a directory above it, is a symlink, junction, or not a regular file. Journal entries must be real files inside the entries directory.";
  }
}

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
// uploads, deletion, or watchers -- (b) rejects a symlinked ancestor
// anywhere between the workspace root and the media root, and (c)
// rejects a media root that is itself a symlink (or not a directory).
// (c) matters here specifically because the watcher and the webview's
// resource roots consume this path directly and, unlike scan/upload/
// delete, do not re-check the root -- and hasSymlinkedAncestor
// deliberately never inspects the root itself. All three checks are
// explicitly scoped to media only, since upload and delete give an
// escaping or symlinked path a way to write or delete outside the blog
// that entries (read-mostly) does not have. Entry containment is
// intentionally left unchanged; it has the same latent gap, but fixing
// it is a separate, pre-existing concern outside this feature's scope.
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
  if (!(await isMediaRootWatchable(mediaDir))) {
    return undefined;
  }
  return mediaDir;
}

// Portable, forward-slash media-directory path relative to the
// configured blog directory (e.g. "media" or "assets/uploads"),
// formatted from the exact mediaDir snapshot the caller already
// resolved via resolveMediaDir() -- never a second configuration read
// -- so an inserted media link target cannot drift from the scan or
// resource-root generation. undefined when there is no blog directory
// or mediaDir is not contained within it, in which case media
// insertion is refused rather than guessed. Presentation/derivation
// only: no filesystem access.
function portableMediaDirPath(mediaDir: string): string | undefined {
  const blogDir = resolveBlogDir();
  return blogDir ? toPortableBlogRelativePath(blogDir, mediaDir) : undefined;
}

// Presentation label for the Media heading, formatted from the exact
// mediaDir snapshot pushState() already resolved -- never a second
// configuration read -- so the label cannot drift from the file scan.
// A resolved directory becomes a portable workspace-relative path
// (e.g. "blog/assets") whether or not it exists on disk yet; undefined
// (or a target that somehow escapes the workspace) becomes the
// unavailable fallback so an absolute filesystem path is never shown.
function describeMediaLocation(mediaDir: string | undefined): string {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!mediaDir || !workspaceFolder) {
    return MEDIA_LOCATION_UNAVAILABLE;
  }
  return (
    toWorkspaceRelativeDisplayPath(workspaceFolder.uri.fsPath, mediaDir) ??
    MEDIA_LOCATION_UNAVAILABLE
  );
}

// Reveals the current media directory in the OS file manager. The
// target is resolved fresh through resolveMediaDir() at invocation --
// never a cached path, since configuration or an ancestor's symlink
// status may have changed since the heading was last drawn -- and is
// revealed only when it currently exists as a real (non-symlinked)
// directory. A missing (not-yet-created), unsafe, or unresolvable
// target reports an error and reveals nothing. Nothing here creates
// the directory or falls back to an ancestor.
async function revealMediaDirectory(): Promise<void> {
  try {
    const mediaDir = await resolveMediaDir();
    if (!mediaDir) {
      vscode.window.showErrorMessage(
        "No safe media directory is available. Check vsJournal.blogPath and vsJournal.mediaPath."
      );
      return;
    }
    if (!(await isMediaRootDirectory(mediaDir))) {
      vscode.window.showErrorMessage(
        "The media directory does not exist yet. Upload a media file to create it."
      );
      return;
    }
    await vscode.commands.executeCommand(
      "revealFileInOS",
      vscode.Uri.file(mediaDir)
    );
  } catch (error) {
    vscode.window.showErrorMessage(
      `Failed to reveal media directory: ${error}`
    );
  }
}

// Owns the lifecycle of the SQLite index for the configured journal:
// opens it on activation, reopens it when vsJournal.blogPath changes,
// and closes it on deactivation. All consumers reach the index through
// get()/ensure(), and generation ownership (see IndexLifecycle) makes a
// blogPath change mid-open retire that open rather than let it publish
// directory A's index under configuration B.
class IndexHost {
  private readonly lifecycle: IndexLifecycle<BlogIndex>;

  constructor() {
    this.lifecycle = new IndexLifecycle<BlogIndex>({
      resolveTarget: () => this.entriesDir(),
      open: (entriesDir, createBlogDir) =>
        this.openForConfig(entriesDir, createBlogDir),
      close: (index) => index.close(),
    });
  }

  get(): BlogIndex | undefined {
    return this.lifecycle.get();
  }

  isDisposed(): boolean {
    return this.lifecycle.isDisposed();
  }

  entriesDir(): string | undefined {
    const blogDir = resolveBlogDir();
    return blogDir ? path.join(blogDir, "entries") : undefined;
  }

  // Opens (or returns) the index for the current configuration. The
  // database is created on demand, but only once the blog directory
  // itself exists so activation never scaffolds directories into
  // workspaces that don't use the extension. A caller always receives
  // the current directory's index or undefined, never one retired by a
  // concurrent blogPath change.
  ensure(createBlogDir = false): Promise<BlogIndex | undefined> {
    return this.lifecycle.ensure(createBlogDir);
  }

  // Closes the active index and retires any in-flight open so the next
  // ensure() reopens for the new configuration.
  reopen(): Promise<void> {
    return this.lifecycle.invalidate();
  }

  // Terminal and idempotent: awaits the in-flight open and every owned
  // close; no later ensure() can reopen.
  dispose(): Promise<void> {
    return this.lifecycle.dispose();
  }

  private async openForConfig(
    entriesDir: string,
    createBlogDir: boolean
  ): Promise<BlogIndex | undefined> {
    const anchor = workspaceTrustAnchor();
    if (!anchor) {
      return undefined;
    }
    try {
      // Validate every existing component from the workspace root down to
      // the entries directory. A symlink/junction anywhere on the chain
      // is fatal; a missing blog/entries directory is created only in an
      // authorized flow (New Entry), never by passive activation.
      const chain = await verifyContainedRealDirectoryChain(
        anchor,
        entriesDir,
        "unsafe-root",
        { allowMissingTail: true }
      );
      if (chain.status === "missing") {
        if (!createBlogDir) {
          return undefined;
        }
        await createSafeContainedDirectory(anchor, entriesDir, "unsafe-root");
      }
      return await BlogIndex.open(entriesDir, anchor);
    } catch (error) {
      this.reportOpenFailure(error);
      return undefined;
    }
  }

  private reportOpenFailure(error: unknown): void {
    console.error("VS Journal: failed to open the entry index:", error);
    if (error instanceof EntryContainmentError) {
      vscode.window.showErrorMessage(describeContainmentError(error));
      return;
    }
    vscode.window.showErrorMessage(
      `VS Journal could not open its entry index: ${error}`
    );
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
      describeMediaLocation: (mediaDir) => describeMediaLocation(mediaDir),
      toPortableMediaDir: (mediaDir) => portableMediaDirPath(mediaDir),
      getEntriesDir: () => host.entriesDir(),
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
  let mediaWatcherGeneration = 0;

  // Rebinding is safe to call repeatedly: dispose+recreate. Called on
  // activation, on a blogPath change, on a mediaPath change, and after
  // an upload that just created the media directory on demand -- a
  // watcher bound before the directory existed may never have started
  // watching it. createMediaWatcher() is async, so two rebinds can be
  // in flight at once (e.g. two quick mediaPath edits); a generation
  // token ensures only the newest call's watcher is retained and any
  // watcher produced by a superseded call is disposed rather than left
  // bound to a stale directory.
  async function rebindMediaWatcher(): Promise<void> {
    const generation = ++mediaWatcherGeneration;
    mediaWatcherDisposable?.dispose();
    mediaWatcherDisposable = undefined;
    const next = await createMediaWatcher(refreshMediaView);
    if (generation !== mediaWatcherGeneration) {
      next?.dispose();
      return;
    }
    mediaWatcherDisposable = next;
    if (next) {
      context.subscriptions.push(next);
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

  const revealMediaDirectoryCommand = vscode.commands.registerCommand(
    "vsJournal.revealMediaDirectory",
    async () => {
      await revealMediaDirectory();
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
    refreshMediaLibraryCommand,
    revealMediaDirectoryCommand
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
    // Deactivation (or, at worst, a redundant newer change) may have run
    // while the index reopened; never rebind watchers or repaint views
    // as current after the host has been disposed.
    if (host.isDisposed()) {
      return;
    }
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
    // A blogPath change or deactivation during reconcile() retires this
    // index; don't present its contents or offer its gitignore rule as
    // the current journal.
    if (host.get() !== index) {
      return;
    }
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
    // Containment guard: reject a lexical escape, any symlinked path
    // component, and a non-regular final file. Never resolve or open an
    // indexed path outside the configured entries directory.
    const absolutePath = await index.resolveSafeExistingEntryPath(relativePath);
    if (!absolutePath) {
      vscode.window.showErrorMessage(
        `That entry cannot be opened safely: ${relativePath}`
      );
      return;
    }
    // Revalidate at the open boundary: a component swapped for a link
    // between resolution and open must not be handed to openTextDocument.
    const anchor = workspaceTrustAnchor();
    try {
      if (!anchor) {
        throw new EntryContainmentError(
          "unsafe-entry",
          absolutePath,
          "No workspace trust anchor"
        );
      }
      await assertSafeExistingFile(anchor, absolutePath, "unsafe-entry");
    } catch {
      vscode.window.showErrorMessage(
        `That entry cannot be opened safely: ${relativePath}`
      );
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

    // Reject a configured root whose existing chain runs through a
    // symlink or junction before it is stored or created.
    try {
      await verifyContainedRealDirectoryChain(
        workspaceFolder.uri.fsPath,
        fullPath,
        "unsafe-root",
        { allowMissingTail: true }
      );
    } catch (error) {
      if (error instanceof EntryContainmentError) {
        vscode.window.showErrorMessage(describeContainmentError(error));
        return;
      }
      throw error;
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
        try {
          await createSafeContainedDirectory(
            workspaceFolder.uri.fsPath,
            path.join(fullPath, "entries"),
            "unsafe-root"
          );
          vscode.window.showInformationMessage(
            `Blog directory created at: ${newPath}`
          );
        } catch (error) {
          if (error instanceof EntryContainmentError) {
            vscode.window.showErrorMessage(describeContainmentError(error));
            return;
          }
          throw error;
        }
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

    const anchor = workspaceTrustAnchor();
    if (!anchor) {
      vscode.window.showErrorMessage("No workspace folder found.");
      return;
    }

    const now = moment();
    const entryDir = path.join(
      index.entriesDir,
      now.format("YYYY"),
      now.format("MM"),
      now.format("DD")
    );
    // Validate the entries root and the date-directory chain, then create
    // any missing component through validated real directories and
    // revalidate each created component. A linked or swapped ancestor
    // aborts here before anything is written, indexed, or opened.
    await createSafeContainedDirectory(anchor, entryDir, "unsafe-entry");

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

    // Revalidate the date directory immediately before the exclusive
    // create.
    await assertSafeExistingDirectory(anchor, entryDir, "unsafe-entry");

    // Exclusive create with retry, so two same-titled entries created the
    // same day never silently overwrite each other.
    const filePath = await createUniqueFile(entryDir, filename, content);

    // The freshly created path must be a regular, non-symlink file, and
    // its chain must still be safe, before it is indexed or opened.
    await assertSafeExistingFile(anchor, filePath, "unsafe-entry");
    await index.upsertFromFile(filePath);

    const document = await vscode.workspace.openTextDocument(filePath);
    await vscode.window.showTextDocument(document);

    vscode.window.showInformationMessage(
      `Blog entry "${title}" created successfully!`
    );
  } catch (error) {
    if (error instanceof EntryContainmentError) {
      vscode.window.showErrorMessage(describeContainmentError(error));
      return;
    }
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
