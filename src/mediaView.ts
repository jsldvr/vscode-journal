import * as vscode from "vscode";
import * as fs from "fs-extra";
import * as path from "path";
import {
  formatBytes,
  importMediaFile,
  isMediaRootDirectory,
  resolveContainedMediaFilePath,
  scanMediaDirectory,
} from "./mediaLibrary";
import { normalizeEntryPath } from "./pathUtils";
import {
  InboundMediaMessage,
  MediaCopyPathMessage,
  MediaDeleteMessage,
  MediaOpenMessage,
  MediaRevealMessage,
} from "./mediaWebviewSupport";
import { MediaFile } from "./types";
import { MediaDetailsPanel } from "./mediaDetailsPanel";

export interface MediaControllerDeps {
  // undefined => no workspace open, the configured blog path resolves
  // outside the workspace, or a symlinked ancestor between the
  // workspace root and the media root was detected -- the section
  // renders a disabled state instead of throwing. A valid path whose
  // media/ directory does not yet exist on disk is NOT undefined here:
  // that is the normal, upload-capable empty-library state. Async
  // because resolving it safely requires walking and lstat-ing the
  // path ancestry.
  getMediaDir(): Promise<string | undefined>;
  // Called after upload has ensured mediaDir exists, so the caller can
  // rebind a watcher that may have been created before the directory
  // existed.
  onMediaDirEnsured?(): void;
  // A *full* refresh: recompute localResourceRoots and then push a
  // fresh file snapshot, in that order. MediaController cannot do this
  // itself -- only the webview's owner (SearchViewProvider) can mutate
  // webview.options -- so this always resolves to
  // SearchViewProvider.refreshMedia(). Required (not just pushState())
  // after upload and on an explicit "mediaRefresh" request: the very
  // first upload is what creates media/ on demand, and until
  // localResourceRoots is recomputed to include it, any previewUri
  // pushState() emits for the newly uploaded images is unservable.
  requestFullRefresh(): Promise<void>;
}

export interface MediaFileWire extends MediaFile {
  previewUri?: string;
  sizeLabel: string;
}

type ReplyFn = (message: Record<string, unknown>) => void;
type MediaFileActionMessage =
  | MediaOpenMessage
  | MediaRevealMessage
  | MediaCopyPathMessage
  | MediaDeleteMessage;

// Owns the media half of the combined Journal webview -- the sidebar
// grid, filesystem state, and the outbound "media*" messages -- plus
// the lifecycle of the single editor-area details panel a tile
// selection opens. Not a vscode.WebviewViewProvider itself -- there is
// exactly one contributed view (vsJournal.search), and SearchViewProvider
// composes this controller into its own single webview/message-
// channel/outbox rather than standing up a second view. Every action
// that touches the filesystem (open/reveal/copyPath/delete) re-resolves
// its path through resolveContainedMediaFilePath immediately before
// acting; nothing sent by either webview is trusted as an
// already-safe filesystem path.
export class MediaController {
  private view: vscode.WebviewView | undefined;
  private detailsPanel: MediaDetailsPanel | undefined;

  constructor(
    private readonly deps: MediaControllerDeps,
    private readonly post: (message: Record<string, unknown>) => void
  ) {}

  bind(view: vscode.WebviewView): void {
    this.view = view;
  }

  unbind(): void {
    this.view = undefined;
  }

  // Recomputes localResourceRoots for the live media directory. Callers
  // apply the result to view.webview.options; kept separate from
  // mutating webview.options directly so SearchViewProvider can merge
  // it with its own options assignment. getMediaDir() only guards
  // ancestors above mediaRoot -- mediaRoot itself must additionally be
  // verified as a real, non-symlinked directory here, since a symlinked
  // mediaRoot must never be added to localResourceRoots (that would let
  // the webview's own resource-fetch pipeline, which enforces
  // containment purely against localResourceRoots and is entirely
  // separate from resolveContainedMediaFilePath, follow the symlink).
  async resourceRoots(): Promise<vscode.Uri[]> {
    const mediaDir = await this.deps.getMediaDir();
    if (!mediaDir) {
      return [];
    }
    return (await isMediaRootDirectory(mediaDir)) ? [vscode.Uri.file(mediaDir)] : [];
  }

  // Re-scans the media directory and pushes a fresh snapshot. Called on
  // "ready", watcher events, after upload/delete, and whenever the blog
  // path changes. Also keeps an open details panel in sync: if its file
  // is missing from the fresh scan (deleted, excluded, or the whole
  // root became unsafe), the panel is switched to its unavailable state
  // rather than continuing to show stale data.
  async pushState(): Promise<void> {
    const mediaDir = await this.deps.getMediaDir();
    if (!mediaDir) {
      this.post({
        type: "mediaDisabled",
        reason:
          "No workspace open, the configured blog path is outside the workspace, or the media path is unsafe.",
      });
      // sync, not show: this is a background refresh path, not a user
      // selection -- a hidden details tab must not be yanked to the
      // foreground just because the media root became unavailable.
      this.detailsPanel?.syncUnavailable();
      return;
    }
    try {
      const files = await scanMediaDirectory(mediaDir);
      this.post({
        type: "mediaFiles",
        files: files.map((file) => this.toWire(mediaDir, file)),
      });
      if (this.detailsPanel) {
        const current = files.find((file) => file.path === this.detailsPanel?.currentPath);
        if (current) {
          this.detailsPanel.syncFile(this.toWire(mediaDir, current), mediaDir);
        } else {
          this.detailsPanel.syncUnavailable();
        }
      }
    } catch (error) {
      console.error("VS Journal: failed to scan media directory:", error);
      // Disable rather than just posting a status message: the webview
      // must drop its previously loaded file list and previewUris on
      // any scan failure, not just report the failure alongside stale
      // data. A legitimate directory replaced by a symlink between one
      // refresh and the next is exactly this case -- the old
      // previewUris pointed at the real files that used to be there,
      // and must not keep rendering as if nothing changed.
      this.post({
        type: "mediaDisabled",
        reason: "Failed to load media files. The media directory may be unavailable or unsafe.",
      });
      this.detailsPanel?.syncUnavailable();
    }
  }

  async upload(): Promise<void> {
    const initialMediaDir = await this.deps.getMediaDir();
    if (!initialMediaDir) {
      vscode.window.showErrorMessage(
        "No workspace open, or the configured blog/media path is unsafe."
      );
      return;
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: "Upload",
    });
    if (!uris || uris.length === 0) {
      return;
    }

    // The picker can stay open indefinitely; vsJournal.blogPath could
    // change, or an ancestor could be replaced with a symlink, while
    // the user is choosing files. Re-resolve and compare immediately
    // before writing anything -- never import against a destination
    // that was only valid when the dialog opened.
    const mediaDir = await this.deps.getMediaDir();
    if (!mediaDir || mediaDir !== initialMediaDir) {
      this.post({
        type: "mediaStatus",
        message: "The blog location changed while the file picker was open; upload cancelled.",
        isError: true,
      });
      return;
    }

    const imported: string[] = [];
    const failures: string[] = [];
    for (const uri of uris) {
      try {
        const result = await importMediaFile(mediaDir, uri.fsPath, path.basename(uri.fsPath));
        imported.push(result.path);
      } catch (error) {
        console.error("VS Journal: failed to import media file:", error);
        failures.push(path.basename(uri.fsPath));
      }
    }

    this.deps.onMediaDirEnsured?.();
    // Not pushState(): a first-ever upload is what just created
    // mediaDir, and localResourceRoots must be recomputed to include it
    // before the previewUris pushState() is about to emit can serve.
    await this.deps.requestFullRefresh();

    // Uploading never selects or opens a file -- the grid simply shows
    // the new files; the user opens details explicitly, same as any
    // other tile.
    if (imported.length > 0) {
      this.post({ type: "mediaUploaded", paths: imported });
    }
    if (failures.length > 0) {
      this.post({
        type: "mediaStatus",
        message: `Failed to import: ${failures.join(", ")}.`,
        isError: true,
      });
    }
  }

  // Messages from the sidebar grid: refresh/upload/select. Selecting
  // never happens implicitly (on load, refresh, or upload) -- only in
  // response to this explicit "mediaSelect" message, which the sidebar
  // script sends solely from a tile's click/keyboard-activation handler.
  async dispatch(message: InboundMediaMessage): Promise<void> {
    switch (message.type) {
      case "mediaRefresh":
        // Also a full refresh, not just pushState(): the webview's own
        // Refresh button must be able to recover from the same stale-
        // resource-roots situation (e.g. right after the very first
        // upload, or after a blog-path change) without requiring some
        // other event to happen to recompute them first.
        await this.deps.requestFullRefresh();
        return;
      case "mediaUpload":
        await this.upload();
        return;
      case "mediaSelect":
        await this.openDetailsFor(message.path);
        return;
    }
  }

  // Messages from the details panel: open/reveal/copyPath/delete. Kept
  // separate from dispatch() (the sidebar's message set) because
  // replies must go back to whichever webview asked -- the panel here,
  // never the sidebar -- and because the sidebar no longer has any UI
  // that sends these. Never rejects: a failure from getMediaDir(), a
  // VS Code command, or the clipboard must never escape as an
  // unhandled promise rejection -- it is reported as a normal status
  // reply instead. The catch lives here (on the method itself) rather
  // than only in the one call site that currently invokes it, so the
  // guarantee holds for any future caller too.
  async performAction(message: MediaFileActionMessage, reply: ReplyFn): Promise<void> {
    try {
      switch (message.type) {
        case "mediaOpen":
          await this.openFile(message.path, reply);
          return;
        case "mediaReveal":
          await this.revealFile(message.path, reply);
          return;
        case "mediaCopyPath":
          await this.copyPath(message.path, reply);
          return;
        case "mediaDelete":
          await this.deleteFile(message.path, reply);
          return;
      }
    } catch (error) {
      console.error(`VS Journal: media details panel "${message.type}" action failed:`, error);
      reply({
        type: "mediaStatus",
        message: "That action could not be completed.",
        isError: true,
      });
    }
  }

  // Opens (creating on first use) or updates+reveals the single reused
  // details panel for relativePath. Looked up via a fresh
  // scanMediaDirectory() rather than any cached list, so the panel
  // never renders from stale data: a file that has disappeared, become
  // unsafe, or been excluded is shown as unavailable instead.
  private async openDetailsFor(relativePath: string): Promise<void> {
    // mediaDir can already be undefined here (a blogPath change or a
    // newly-unsafe ancestor can land between the grid rendering the
    // tile and the click being handled) -- that must still surface as
    // an explicit unavailable selection, the same as a file that
    // disappeared from a valid root, rather than silently doing
    // nothing in response to a click the user just made.
    const mediaDir = await this.deps.getMediaDir();
    const file = mediaDir ? await this.lookupFile(mediaDir, relativePath) : undefined;
    if (!this.detailsPanel) {
      this.detailsPanel = new MediaDetailsPanel(
        (message, reply) => void this.performAction(message, reply),
        () => {
          this.detailsPanel = undefined;
        }
      );
    }
    if (file && mediaDir) {
      this.detailsPanel.show(file, mediaDir);
    } else {
      this.detailsPanel.showUnavailable();
    }
  }

  private async lookupFile(mediaDir: string, relativePath: string): Promise<MediaFileWire | undefined> {
    try {
      const files = await scanMediaDirectory(mediaDir);
      const match = files.find((file) => file.path === relativePath);
      return match ? this.toWire(mediaDir, match) : undefined;
    } catch (error) {
      console.error("VS Journal: failed to look up media file:", error);
      return undefined;
    }
  }

  private toWire(mediaDir: string, file: MediaFile): MediaFileWire {
    const wire: MediaFileWire = { ...file, sizeLabel: formatBytes(file.size) };
    if (file.type === "image" && this.view) {
      const uri = vscode.Uri.file(path.join(mediaDir, file.path));
      wire.previewUri = this.view.webview.asWebviewUri(uri).toString();
    }
    return wire;
  }

  private async resolveOrReportMissing(
    relativePath: string,
    reply: ReplyFn
  ): Promise<string | undefined> {
    const result = await this.resolveOrReportMissingWithRoot(relativePath, reply);
    return result?.resolved;
  }

  private async resolveOrReportMissingWithRoot(
    relativePath: string,
    reply: ReplyFn
  ): Promise<{ mediaDir: string; resolved: string } | undefined> {
    const mediaDir = await this.deps.getMediaDir();
    if (!mediaDir) {
      return undefined;
    }
    const resolved = await resolveContainedMediaFilePath(mediaDir, relativePath);
    if (!resolved) {
      reply({
        type: "mediaStatus",
        message: "That file is no longer available.",
        isError: true,
      });
      return undefined;
    }
    return { mediaDir, resolved };
  }

  private async openFile(relativePath: string, reply: ReplyFn): Promise<void> {
    const resolved = await this.resolveOrReportMissing(relativePath, reply);
    if (!resolved) {
      return;
    }
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(resolved));
  }

  private async revealFile(relativePath: string, reply: ReplyFn): Promise<void> {
    const resolved = await this.resolveOrReportMissing(relativePath, reply);
    if (!resolved) {
      return;
    }
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(resolved));
  }

  private async copyPath(relativePath: string, reply: ReplyFn): Promise<void> {
    const mediaDir = await this.deps.getMediaDir();
    const resolved = await this.resolveOrReportMissing(relativePath, reply);
    if (!resolved || !mediaDir) {
      return;
    }
    const relative = normalizeEntryPath(path.relative(mediaDir, resolved));
    await vscode.env.clipboard.writeText(`media/${relative}`);
    reply({ type: "mediaStatus", message: `Copied media/${relative} to the clipboard.` });
  }

  private async deleteFile(relativePath: string, reply: ReplyFn): Promise<void> {
    const initial = await this.resolveOrReportMissingWithRoot(relativePath, reply);
    if (!initial) {
      return;
    }
    const name = path.basename(initial.resolved);
    const choice = await vscode.window.showWarningMessage(
      `Delete "${name}"? This action cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") {
      return;
    }

    // Re-resolve immediately before deleting, against the SAME media
    // root captured before the modal: the file could have been deleted,
    // replaced, or swapped for a directory/symlink during the modal
    // pause, or vsJournal.blogPath could have changed to point at an
    // entirely different blog while the modal was open. Requiring both
    // the media root and the resolved absolute path to match the
    // pre-modal values closes that gap -- without it, a relativePath
    // that happens to also exist under a *different* blog's media root
    // would be deleted from that unrelated blog instead of aborting.
    // fs.unlink (not a recursive remove) additionally refuses outright
    // if the target somehow became a directory.
    const mediaDir = await this.deps.getMediaDir();
    const revalidated =
      mediaDir === initial.mediaDir
        ? await resolveContainedMediaFilePath(mediaDir, relativePath)
        : undefined;
    if (!revalidated || revalidated !== initial.resolved) {
      reply({
        type: "mediaStatus",
        message: `"${name}" changed before deletion could complete; nothing was deleted.`,
        isError: true,
      });
      return;
    }

    try {
      await fs.unlink(revalidated);
    } catch (error) {
      console.error("VS Journal: failed to delete media file:", error);
      reply({
        type: "mediaStatus",
        message: `Failed to delete "${name}".`,
        isError: true,
      });
      return;
    }
    // Refreshes the sidebar grid; pushState()'s own sync already
    // switches the panel to its unavailable state since the deleted
    // file will be missing from the fresh scan. The explicit reply
    // below then gives the panel a more specific "deleted" message
    // (applied after, so it is the one actually shown).
    await this.pushState();
    reply({ type: "mediaDeleted", path: relativePath });
  }
}

// HTML fragment for the media section, appended below the entries
// browse list inside the single combined webview body. Wrapped in its
// own scrolling container (max-height + overflow-y) so its own
// toolbar can be sticky *relative to that container* without competing
// with the entries search bar for position:sticky/top:0 in the same
// scroll context.
export const MEDIA_BODY_HTML = `
  <div class="section-heading">Media</div>
  <div id="media-section">
    <div class="media-toolbar">
      <input id="media-search" type="text" placeholder="Search media..." aria-label="Search media files" autocomplete="off" spellcheck="false">
      <select id="media-type-filter" aria-label="Filter by media type">
        <option value="all">All</option>
        <option value="image">Images</option>
        <option value="audio">Audio</option>
        <option value="video">Video</option>
        <option value="document">Documents/Other</option>
      </select>
      <button id="media-upload" class="icon-button" type="button" aria-label="Upload media">Upload</button>
      <button id="media-refresh" class="icon-button" type="button" aria-label="Refresh media library">Refresh</button>
    </div>
    <div id="media-status" role="status"></div>
    <div id="media-disabled-state"></div>
    <div id="media-empty-state"></div>
    <div id="media-grid" role="list" aria-label="Media files"></div>
  </div>
`;

// CSS for the media section, appended to the shared <style> block in
// searchView.ts. Reuses the entries webview's .cta class for the
// "Upload Media" empty-state action (same link-style treatment). There
// is no details/preview markup here -- selecting a tile opens an
// editor-area panel (see mediaDetailsPanel.ts) instead of rendering
// anything below the grid.
export const MEDIA_STYLES = `
  .section-heading {
    padding: 6px 10px 2px 10px;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent));
  }
  #media-section {
    max-height: 60vh;
    overflow-y: auto;
  }
  .media-toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 6px 8px;
    position: sticky;
    top: 0;
    background: var(--vscode-sideBar-background);
    z-index: 1;
  }
  #media-search {
    flex: 1 1 100%;
    padding: 4px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    outline-color: var(--vscode-focusBorder);
  }
  #media-search::placeholder { color: var(--vscode-input-placeholderForeground); }
  #media-type-filter {
    flex: 1;
    min-width: 0;
    padding: 3px 4px;
    color: var(--vscode-dropdown-foreground);
    background: var(--vscode-dropdown-background);
    border: 1px solid var(--vscode-dropdown-border, transparent);
    border-radius: 2px;
  }
  .icon-button {
    padding: 3px 8px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    cursor: pointer;
  }
  .icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
  #media-search:focus-visible, #media-type-filter:focus-visible, .icon-button:focus-visible,
  .tile:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  #media-status {
    padding: 4px 10px;
    color: var(--vscode-descriptionForeground);
  }
  #media-status.error { color: var(--vscode-errorForeground); }
  #media-status:empty { display: none; }
  #media-disabled-state, #media-empty-state {
    padding: 8px 10px;
    color: var(--vscode-descriptionForeground);
  }
  #media-disabled-state:empty, #media-empty-state:empty { display: none; }
  #media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
    gap: 8px;
    padding: 8px;
  }
  #media-grid:empty { display: none; }
  .tile {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 4px;
    color: inherit;
    font: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    cursor: pointer;
  }
  .tile:hover { background: var(--vscode-list-hoverBackground); }
  .thumb {
    width: 100%;
    aspect-ratio: 1 / 1;
    object-fit: cover;
    border-radius: 3px;
    background: var(--vscode-input-background);
  }
  .placeholder {
    width: 100%;
    aspect-ratio: 1 / 1;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.75em;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-input-background);
    border-radius: 3px;
  }
  .tile-name {
    width: 100%;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    font-size: 0.85em;
    text-align: center;
  }
`;

// Plain-JS fragment spliced into the combined webview script in
// searchView.ts. Shares that script's single acquireVsCodeApi()
// instance and getState()/setState() blob (under a "media" sub-key)
// rather than calling acquireVsCodeApi() a second time, which VS Code
// does not allow. Rendering rule: every dynamic string (filenames,
// paths) is assigned through textContent, never innerHTML. Search
// query and active type filter persist via the shared state so they
// survive the webview being hidden and shown again; selection is
// intentionally NOT part of persisted state -- clicking/activating a
// tile is a one-off "open details" request (mediaSelect), not
// something the sidebar tracks, highlights, or restores.
export const MEDIA_SCRIPT = `
function initMedia(vscode, state, save) {
  var searchInput = document.getElementById("media-search");
  var typeFilter = document.getElementById("media-type-filter");
  var uploadButton = document.getElementById("media-upload");
  var refreshButton = document.getElementById("media-refresh");
  var statusEl = document.getElementById("media-status");
  var disabledEl = document.getElementById("media-disabled-state");
  var emptyEl = document.getElementById("media-empty-state");
  var gridEl = document.getElementById("media-grid");

  var TYPE_LABELS = { image: "Image", audio: "Audio", video: "Video", document: "Document" };

  state.media = state.media || {
    query: "",
    filter: "all",
    files: [],
    disabled: false,
    disabledReason: "",
    loaded: false,
  };
  var m = state.media;
  m.files = m.files || [];
  // Older persisted state may still carry a selectedPath from before
  // selection moved to the editor area -- never restore it.
  delete m.selectedPath;

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.className = isError ? "error" : "";
  }

  function matchesFilter(file) {
    if (m.filter !== "all" && file.type !== m.filter) { return false; }
    var query = m.query.trim().toLowerCase();
    if (query.length === 0) { return true; }
    return file.name.toLowerCase().indexOf(query) >= 0 ||
      file.path.toLowerCase().indexOf(query) >= 0;
  }

  function visibleFiles() {
    return m.files.filter(matchesFilter);
  }

  function makeThumb(file) {
    if (file.type === "image" && file.previewUri) {
      var img = document.createElement("img");
      img.className = "thumb";
      img.loading = "lazy";
      img.src = file.previewUri;
      img.alt = "";
      return img;
    }
    var placeholder = document.createElement("div");
    placeholder.className = "placeholder";
    placeholder.textContent = TYPE_LABELS[file.type] || "File";
    return placeholder;
  }

  function makeTile(file) {
    var tile = document.createElement("button");
    tile.type = "button";
    tile.className = "tile";
    tile.setAttribute("role", "listitem");
    tile.setAttribute("aria-label", "Open details for " + file.name + ", " + (TYPE_LABELS[file.type] || "file"));
    tile.appendChild(makeThumb(file));

    var name = document.createElement("div");
    name.className = "tile-name";
    name.textContent = file.name;
    name.title = file.name;
    tile.appendChild(name);

    // Selecting a tile only ever requests that the editor-area details
    // panel open/update for this file -- no sidebar state changes.
    tile.addEventListener("click", function () {
      vscode.postMessage({ type: "mediaSelect", path: file.path });
    });
    return tile;
  }

  function renderGrid() {
    gridEl.textContent = "";
    var files = visibleFiles();
    for (var i = 0; i < files.length; i++) {
      gridEl.appendChild(makeTile(files[i]));
    }
  }

  function renderEmptyState() {
    emptyEl.textContent = "";
    if (!m.loaded || m.disabled) { return; }
    if (m.files.length === 0) {
      var message = document.createElement("div");
      message.textContent = "No media files yet. ";
      var cta = document.createElement("button");
      cta.className = "cta";
      cta.type = "button";
      cta.textContent = "Upload Media";
      cta.addEventListener("click", function () {
        vscode.postMessage({ type: "mediaUpload" });
      });
      message.appendChild(cta);
      emptyEl.appendChild(message);
    } else if (visibleFiles().length === 0) {
      emptyEl.textContent = "No files match your search.";
    }
  }

  function renderDisabled() {
    disabledEl.textContent = "";
    if (!m.disabled) { return; }
    var message = document.createElement("div");
    message.textContent = m.disabledReason || "Media library unavailable.";
    disabledEl.appendChild(message);
  }

  function render() {
    renderDisabled();
    if (m.disabled) {
      gridEl.textContent = "";
      emptyEl.textContent = "";
      return;
    }
    renderGrid();
    renderEmptyState();
  }

  searchInput.value = m.query;
  typeFilter.value = m.filter;

  searchInput.addEventListener("input", function () {
    m.query = searchInput.value;
    save();
    render();
  });
  typeFilter.addEventListener("change", function () {
    m.filter = typeFilter.value;
    save();
    render();
  });
  uploadButton.addEventListener("click", function () {
    vscode.postMessage({ type: "mediaUpload" });
  });
  refreshButton.addEventListener("click", function () {
    vscode.postMessage({ type: "mediaRefresh" });
  });

  render();

  return {
    handlers: {
      mediaFiles: function (message) {
        m.disabled = false;
        m.disabledReason = "";
        m.files = message.files;
        m.loaded = true;
        save();
        render();
      },
      mediaDisabled: function (message) {
        m.disabled = true;
        m.disabledReason = message.reason;
        m.loaded = true;
        save();
        render();
      },
      mediaStatus: function (message) {
        setStatus(message.message, !!message.isError);
      },
      mediaUploaded: function (message) {
        // Never selects the uploaded file(s) -- just confirms the count.
        setStatus(
          message.paths.length === 1 ? "Uploaded 1 file." : "Uploaded " + message.paths.length + " files.",
          false
        );
      },
      mediaDeleted: function () {
        setStatus("File deleted.", false);
      },
    },
  };
}
`;
