import * as vscode from "vscode";
import * as crypto from "crypto";
import {
  validateMediaMessage,
  MediaCopyPathMessage,
  MediaDeleteMessage,
  MediaOpenMessage,
  MediaRevealMessage,
} from "./mediaWebviewSupport";
import { MediaFileWire } from "./mediaView";

type ReplyFn = (message: Record<string, unknown>) => void;
type MediaFileActionMessage =
  | MediaOpenMessage
  | MediaRevealMessage
  | MediaCopyPathMessage
  | MediaDeleteMessage;

const VIEW_TYPE = "vsJournal.mediaDetails";

// The single editor-area panel a media tile selection opens: preview,
// metadata, and the Copy Path/Open/Reveal/Delete actions, previously
// rendered below the sidebar grid. One instance is reused across
// selections (the owner -- MediaController -- creates this once and
// calls show()/showUnavailable() on it thereafter; a new instance is
// only created after the user closes the tab). Every action message it
// receives is handed back to the caller-supplied onAction callback,
// which routes through MediaController's own resolveContainedMediaFilePath-
// gated logic -- this class has no filesystem access of its own and
// duplicates none of that safety logic. Rendering rule: every dynamic
// string (filename, path) is assigned through textContent, never
// innerHTML.
export class MediaDetailsPanel {
  private readonly panel: vscode.WebviewPanel;
  private ready = false;
  private pending: Record<string, unknown> | undefined;
  private path: string | undefined;

  constructor(
    private readonly onAction: (message: MediaFileActionMessage, reply: ReplyFn) => void,
    private readonly onDisposed: () => void
  ) {
    this.panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      "Media",
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [] }
    );
    this.panel.webview.html = buildDetailsHtml(this.panel.webview);
    this.panel.webview.onDidReceiveMessage((raw) => this.handleMessage(raw));
    this.panel.onDidDispose(() => this.onDisposed());
  }

  get currentPath(): string | undefined {
    return this.path;
  }

  // Updates and reveals the panel for file. mediaDir scopes
  // localResourceRoots to exactly the directory the previewUri (if any)
  // needs -- recomputed on every call since it can theoretically differ
  // between selections within the same session (a blog-path change).
  show(file: MediaFileWire, mediaDir: string): void {
    this.path = file.path;
    this.panel.title = file.name;
    this.panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.file(mediaDir)],
    };
    this.post({ type: "mediaDetailsData", file });
    this.panel.reveal(vscode.ViewColumn.Active, false);
  }

  showUnavailable(): void {
    this.post({ type: "mediaDetailsUnavailable" });
  }

  private post(message: Record<string, unknown>): void {
    this.pending = message;
    if (this.ready) {
      void this.panel.webview.postMessage(message);
    }
  }

  private handleMessage(raw: unknown): void {
    if (isReadyMessage(raw)) {
      this.ready = true;
      if (this.pending) {
        void this.panel.webview.postMessage(this.pending);
      }
      return;
    }
    const message = validateMediaMessage(raw);
    if (
      message?.type === "mediaOpen" ||
      message?.type === "mediaReveal" ||
      message?.type === "mediaCopyPath" ||
      message?.type === "mediaDelete"
    ) {
      this.onAction(message, (reply) => void this.panel.webview.postMessage(reply));
    }
  }
}

function isReadyMessage(raw: unknown): boolean {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as Record<string, unknown>).type === "ready"
  );
}

// The panel page: restrictive CSP (no remote content; images load only
// from this panel's own resource origin, scoped by localResourceRoots
// to the live media directory on each show(); inline style/script
// authorized only by nonce), VS Code theme variables throughout, and
// DOM-API rendering with textContent so filenames and paths are never
// parsed as HTML. Content is entirely server-driven: the extension
// posts a fresh "mediaDetailsData"/"mediaDetailsUnavailable" message on
// every show()/showUnavailable() call rather than the page tracking any
// client-side selection state of its own.
function buildDetailsHtml(webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Media</title>
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  body {
    padding: 16px;
    margin: 0;
    max-width: 640px;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  #status {
    padding-bottom: 8px;
    color: var(--vscode-descriptionForeground);
  }
  #status.error { color: var(--vscode-errorForeground); }
  #status:empty { display: none; }
  #unavailable {
    padding: 16px 0;
    color: var(--vscode-descriptionForeground);
  }
  #unavailable:empty { display: none; }
  #content:empty { display: none; }
  .detail-preview {
    max-width: 100%;
    max-height: 70vh;
    display: block;
    margin-bottom: 16px;
    border-radius: 4px;
  }
  .detail-placeholder {
    width: 100%;
    height: 240px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1em;
    font-weight: 600;
    letter-spacing: 0.02em;
    color: var(--vscode-descriptionForeground);
    background: var(--vscode-input-background);
    border-radius: 4px;
    margin-bottom: 16px;
  }
  dl { margin: 0 0 16px 0; }
  dt {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    margin-top: 8px;
  }
  dd { margin: 0; overflow-wrap: anywhere; }
  .detail-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .action {
    padding: 5px 12px;
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font: inherit;
  }
  .action:hover { background: var(--vscode-button-hoverBackground); }
  .action:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  .action.danger {
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-errorForeground);
  }
</style>
</head>
<body>
  <div id="status" role="status"></div>
  <div id="content"></div>
  <div id="unavailable"></div>
<script nonce="${nonce}">
${DETAILS_SCRIPT}
</script>
</body>
</html>`;
}

const DETAILS_SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var statusEl = document.getElementById("status");
  var contentEl = document.getElementById("content");
  var unavailableEl = document.getElementById("unavailable");
  var TYPE_LABELS = { image: "Image", audio: "Audio", video: "Video", document: "Document" };

  function setStatus(text, isError) {
    statusEl.textContent = text || "";
    statusEl.className = isError ? "error" : "";
  }

  function makeAction(label, ariaLabel, onClick, danger) {
    var button = document.createElement("button");
    button.type = "button";
    button.className = "action" + (danger ? " danger" : "");
    button.textContent = label;
    button.setAttribute("aria-label", ariaLabel);
    button.addEventListener("click", onClick);
    return button;
  }

  function renderFile(file) {
    unavailableEl.textContent = "";
    contentEl.textContent = "";

    if (file.type === "image" && file.previewUri) {
      var img = document.createElement("img");
      img.className = "detail-preview";
      img.src = file.previewUri;
      img.alt = "";
      contentEl.appendChild(img);
    } else {
      var placeholder = document.createElement("div");
      placeholder.className = "detail-placeholder";
      placeholder.textContent = TYPE_LABELS[file.type] || "File";
      contentEl.appendChild(placeholder);
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
    contentEl.appendChild(dl);

    var actions = document.createElement("div");
    actions.className = "detail-actions";
    actions.appendChild(makeAction("Copy Path", "Copy media path to clipboard", function () {
      vscode.postMessage({ type: "mediaCopyPath", path: file.path });
    }));
    actions.appendChild(makeAction("Open", "Open " + file.name, function () {
      vscode.postMessage({ type: "mediaOpen", path: file.path });
    }));
    actions.appendChild(makeAction("Reveal", "Reveal " + file.name + " in file explorer", function () {
      vscode.postMessage({ type: "mediaReveal", path: file.path });
    }));
    actions.appendChild(makeAction("Delete", "Delete " + file.name, function () {
      vscode.postMessage({ type: "mediaDelete", path: file.path });
    }, true));
    contentEl.appendChild(actions);
  }

  function renderUnavailable() {
    contentEl.textContent = "";
    unavailableEl.textContent = "This file is no longer available.";
  }

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || typeof message.type !== "string") { return; }
    if (message.type === "mediaDetailsData") {
      setStatus("", false);
      renderFile(message.file);
    } else if (message.type === "mediaDetailsUnavailable") {
      setStatus("", false);
      renderUnavailable();
    } else if (message.type === "mediaDeleted") {
      setStatus("File deleted.", false);
      renderUnavailable();
    } else if (message.type === "mediaStatus") {
      setStatus(message.message, !!message.isError);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
`;
