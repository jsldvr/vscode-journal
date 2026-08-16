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
import { InboundMediaMessage } from "./mediaWebviewSupport";
import { MediaFile } from "./types";

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

interface MediaFileWire extends MediaFile {
  previewUri?: string;
  sizeLabel: string;
}

// Owns the media half of the combined Journal webview: filesystem
// state, actions, and the outbound "media*" messages. Not a
// vscode.WebviewViewProvider itself -- there is exactly one contributed
// view (vsJournal.search), and SearchViewProvider composes this
// controller into its own single webview/message-channel/outbox rather
// than standing up a second view. Every action that touches the
// filesystem (open/reveal/copyPath/delete) re-resolves its path through
// resolveContainedMediaFilePath immediately before acting; nothing sent
// by the webview is trusted as an already-safe filesystem path.
export class MediaController {
  private view: vscode.WebviewView | undefined;

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
  // path changes.
  async pushState(): Promise<void> {
    const mediaDir = await this.deps.getMediaDir();
    if (!mediaDir) {
      this.post({
        type: "mediaDisabled",
        reason:
          "No workspace open, the configured blog path is outside the workspace, or the media path is unsafe.",
      });
      return;
    }
    try {
      const files = await scanMediaDirectory(mediaDir);
      this.post({
        type: "mediaFiles",
        files: files.map((file) => this.toWire(mediaDir, file)),
      });
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
      case "mediaOpen":
        await this.openFile(message.path);
        return;
      case "mediaReveal":
        await this.revealFile(message.path);
        return;
      case "mediaCopyPath":
        await this.copyPath(message.path);
        return;
      case "mediaDelete":
        await this.deleteFile(message.path);
        return;
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

  private async resolveOrReportMissing(relativePath: string): Promise<string | undefined> {
    const mediaDir = await this.deps.getMediaDir();
    if (!mediaDir) {
      return undefined;
    }
    const resolved = await resolveContainedMediaFilePath(mediaDir, relativePath);
    if (!resolved) {
      this.post({
        type: "mediaStatus",
        message: "That file is no longer available.",
        isError: true,
      });
      return undefined;
    }
    return resolved;
  }

  private async openFile(relativePath: string): Promise<void> {
    const resolved = await this.resolveOrReportMissing(relativePath);
    if (!resolved) {
      return;
    }
    await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(resolved));
  }

  private async revealFile(relativePath: string): Promise<void> {
    const resolved = await this.resolveOrReportMissing(relativePath);
    if (!resolved) {
      return;
    }
    await vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(resolved));
  }

  private async copyPath(relativePath: string): Promise<void> {
    const mediaDir = await this.deps.getMediaDir();
    const resolved = await this.resolveOrReportMissing(relativePath);
    if (!resolved || !mediaDir) {
      return;
    }
    const relative = normalizeEntryPath(path.relative(mediaDir, resolved));
    await vscode.env.clipboard.writeText(`media/${relative}`);
    this.post({ type: "mediaStatus", message: `Copied media/${relative} to the clipboard.` });
  }

  private async deleteFile(relativePath: string): Promise<void> {
    const resolved = await this.resolveOrReportMissing(relativePath);
    if (!resolved) {
      return;
    }
    const name = path.basename(resolved);
    const choice = await vscode.window.showWarningMessage(
      `Delete "${name}"? This action cannot be undone.`,
      { modal: true },
      "Delete"
    );
    if (choice !== "Delete") {
      return;
    }

    // Re-resolve immediately before deleting: the file could have been
    // deleted, replaced, or swapped for a directory/symlink during the
    // modal pause. resolveContainedMediaFilePath is pure given the same
    // inputs, so a still-valid target resolves to the identical path;
    // anything else means the world changed underneath the selection
    // and deletion must fail closed rather than act on whatever is now
    // at that path. fs.unlink (not a recursive remove) additionally
    // refuses outright if the target somehow became a directory.
    const mediaDir = await this.deps.getMediaDir();
    const revalidated = mediaDir
      ? await resolveContainedMediaFilePath(mediaDir, relativePath)
      : undefined;
    if (!revalidated) {
      this.post({
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
      this.post({
        type: "mediaStatus",
        message: `Failed to delete "${name}".`,
        isError: true,
      });
      return;
    }
    await this.pushState();
    this.post({ type: "mediaDeleted", path: relativePath });
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
    <div id="media-details" aria-label="Selected media file details"></div>
  </div>
`;

// CSS for the media section, appended to the shared <style> block in
// searchView.ts. Reuses the entries webview's .cta class for the
// "Upload Media" empty-state action (same link-style treatment).
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
  .tile:focus-visible, .action:focus-visible {
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
  .tile.selected {
    background: var(--vscode-list-activeSelectionBackground);
    color: var(--vscode-list-activeSelectionForeground);
    border-color: var(--vscode-focusBorder);
  }
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
  #media-details {
    padding: 8px 10px 16px 10px;
    border-top: 1px solid var(--vscode-sideBarSectionHeader-border, var(--vscode-panel-border, transparent));
  }
  #media-details:empty { display: none; }
  #media-details .detail-preview {
    max-width: 100%;
    max-height: 160px;
    display: block;
    margin-bottom: 8px;
    border-radius: 4px;
  }
  #media-details .detail-placeholder {
    width: 100%;
    height: 100px;
    margin-bottom: 8px;
  }
  #media-details dl {
    margin: 0 0 8px 0;
  }
  #media-details dt {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  #media-details dd {
    margin: 0 0 6px 0;
    overflow-wrap: anywhere;
  }
  .detail-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .action {
    padding: 3px 8px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 2px;
    cursor: pointer;
  }
  .action:hover { background: var(--vscode-button-hoverBackground); }
  .action.danger {
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-errorForeground);
  }
`;

// Plain-JS fragment spliced into the combined webview script in
// searchView.ts. Shares that script's single acquireVsCodeApi()
// instance and getState()/setState() blob (under a "media" sub-key)
// rather than calling acquireVsCodeApi() a second time, which VS Code
// does not allow. Rendering rule: every dynamic string (filenames,
// paths) is assigned through textContent, never innerHTML. Search
// query, active type filter, and the current selection persist via the
// shared state so they survive the webview being hidden and shown
// again; the extension only ever pushes the full file list.
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
  var detailsEl = document.getElementById("media-details");

  var TYPE_LABELS = { image: "Image", audio: "Audio", video: "Video", document: "Document" };

  state.media = state.media || {
    query: "",
    filter: "all",
    selectedPath: null,
    files: [],
    disabled: false,
    disabledReason: "",
    loaded: false,
  };
  var m = state.media;
  m.files = m.files || [];

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

  function findFile(relativePath) {
    for (var i = 0; i < m.files.length; i++) {
      if (m.files[i].path === relativePath) { return m.files[i]; }
    }
    return null;
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
    tile.className = "tile" + (m.selectedPath === file.path ? " selected" : "");
    tile.setAttribute("role", "listitem");
    tile.setAttribute("aria-label", file.name + ", " + (TYPE_LABELS[file.type] || "file"));
    tile.setAttribute("aria-pressed", m.selectedPath === file.path ? "true" : "false");
    tile.appendChild(makeThumb(file));

    var name = document.createElement("div");
    name.className = "tile-name";
    name.textContent = file.name;
    name.title = file.name;
    tile.appendChild(name);

    tile.addEventListener("click", function () {
      m.selectedPath = file.path;
      save();
      render();
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

  function makeDetailAction(label, ariaLabel, onClick, danger) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "action" + (danger ? " danger" : "");
    button.textContent = label;
    button.setAttribute("aria-label", ariaLabel);
    button.addEventListener("click", onClick);
    return button;
  }

  function renderDetails() {
    detailsEl.textContent = "";
    if (!m.selectedPath) { return; }
    var file = findFile(m.selectedPath);
    if (!file) {
      m.selectedPath = null;
      save();
      return;
    }

    if (file.type === "image" && file.previewUri) {
      var img = document.createElement("img");
      img.className = "detail-preview";
      img.src = file.previewUri;
      img.alt = "";
      detailsEl.appendChild(img);
    } else {
      var placeholder = document.createElement("div");
      placeholder.className = "placeholder detail-placeholder";
      placeholder.textContent = TYPE_LABELS[file.type] || "File";
      detailsEl.appendChild(placeholder);
    }

    var dl = document.createElement("dl");
    var fields = [
      ["Filename", file.name],
      ["Path", "media/" + file.path],
      ["Type", TYPE_LABELS[file.type] || "File"],
      ["Size", file.sizeLabel],
      ["Modified", new Date(file.mtimeMs).toLocaleString()],
    ];
    for (var i = 0; i < fields.length; i++) {
      var dt = document.createElement("dt");
      dt.textContent = fields[i][0];
      var dd = document.createElement("dd");
      dd.textContent = fields[i][1];
      dl.appendChild(dt);
      dl.appendChild(dd);
    }
    detailsEl.appendChild(dl);

    var actions = document.createElement("div");
    actions.className = "detail-actions";
    actions.appendChild(makeDetailAction("Copy Path", "Copy media path to clipboard", function () {
      vscode.postMessage({ type: "mediaCopyPath", path: file.path });
    }));
    actions.appendChild(makeDetailAction("Open", "Open " + file.name, function () {
      vscode.postMessage({ type: "mediaOpen", path: file.path });
    }));
    actions.appendChild(makeDetailAction("Reveal", "Reveal " + file.name + " in file explorer", function () {
      vscode.postMessage({ type: "mediaReveal", path: file.path });
    }));
    actions.appendChild(makeDetailAction("Delete", "Delete " + file.name, function () {
      vscode.postMessage({ type: "mediaDelete", path: file.path });
    }, true));
    detailsEl.appendChild(actions);
  }

  function render() {
    renderDisabled();
    if (m.disabled) {
      gridEl.textContent = "";
      detailsEl.textContent = "";
      emptyEl.textContent = "";
      return;
    }
    renderGrid();
    renderEmptyState();
    renderDetails();
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
        if (message.paths && message.paths.length > 0) {
          m.selectedPath = message.paths[message.paths.length - 1];
          save();
        }
        setStatus(
          message.paths.length === 1 ? "Uploaded 1 file." : "Uploaded " + message.paths.length + " files.",
          false
        );
      },
      mediaDeleted: function (message) {
        if (m.selectedPath === message.path) {
          m.selectedPath = null;
          save();
        }
        setStatus("File deleted.", false);
      },
    },
  };
}
`;
