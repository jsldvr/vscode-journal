import * as vscode from "vscode";
import * as crypto from "crypto";
import { BlogIndex, InvalidSearchPatternError, SearchOptions, SearchResponse } from "./blogIndex";
import { validateWebviewMessage, InboundWebviewMessage } from "./webviewSupport";
import { groupEntriesByYearMonth } from "./entryGrouping";
import { MediaController, MediaControllerDeps, MEDIA_BODY_HTML, MEDIA_SCRIPT, MEDIA_STYLES } from "./mediaView";
import { validateMediaMessage } from "./mediaWebviewSupport";

export interface SearchViewDeps {
  getIndex(): BlogIndex | undefined;
  openEntry(relativePath: string): Promise<void>;
  createNewEntry(): Promise<void>;
}

// The merged sidebar view: a persistent search bar (with Match
// Case/Whole Word/Regex toggles) pinned at the top, the Year -> Month
// -> Entry browse list / search results / empty-state CTA directly
// below it, and -- below that, in the same webview -- the Media
// library section (search/filter/upload/refresh toolbar, thumbnail
// grid, details pane). There is deliberately only one contributed view
// under the vsJournal container: VS Code only renders a collapsible
// section header when a container has more than one view, and a
// second Media view would also mean a second acquireVsCodeApi()
// context with no shared state -- both are avoided by composing the
// media UI into this single webview/message-channel/outbox instead of
// standing up vsJournal.media as its own WebviewViewProvider.
// All strings rendered in the webview go through DOM textContent (never
// innerHTML), and every message crossing the boundary is validated
// before use.
export class SearchViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "vsJournal.search";

  private view: vscode.WebviewView | undefined;
  private lastQuery = "";
  private lastOptions: SearchOptions = {};
  private pendingFocus = false;
  private webviewReady = false;
  private outbox: Record<string, unknown>[] = [];
  private readonly mediaController: MediaController;

  constructor(
    private readonly deps: SearchViewDeps,
    mediaDeps: Omit<MediaControllerDeps, "requestFullRefresh">
  ) {
    this.mediaController = new MediaController(
      { ...mediaDeps, requestFullRefresh: () => this.refreshMedia() },
      (message) => this.post(message)
    );
  }

  async resolveWebviewView(view: vscode.WebviewView): Promise<void> {
    this.view = view;
    this.webviewReady = false;
    this.outbox = [];
    this.mediaController.bind(view);
    // Resolved before enableScripts/html are ever assigned so the
    // webview's own resource fetches (image previews) are never raced
    // against an in-flight localResourceRoots update.
    const mediaResourceRoots = await this.mediaController.resourceRoots();
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: mediaResourceRoots,
    };
    view.webview.html = buildSearchHtml(view.webview);
    view.webview.onDidReceiveMessage((raw) => this.handleMessage(raw));
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.webviewReady = false;
        this.outbox = [];
        this.mediaController.unbind();
      }
    });
  }

  // Reveals the view and focuses the persistent input. The focus
  // message rides the ready-handshake outbox, so it is delivered even
  // when this call is what causes the webview to load.
  async focusSearchInput(): Promise<void> {
    this.pendingFocus = true;
    await vscode.commands.executeCommand(`${SearchViewProvider.viewType}.focus`);
    this.view?.show(true);
    if (this.webviewReady) {
      this.pendingFocus = false;
      this.post({ type: "focus" });
    }
  }

  clear(): void {
    this.lastQuery = "";
    this.post({ type: "cleared" });
  }

  // Updates the visible input to tag:<value> and runs the query.
  async searchByTag(tag: string): Promise<void> {
    const query = `tag:${tag}`;
    await this.focusSearchInput();
    this.post({ type: "setQuery", query });
    this.lastQuery = query;
    await this.runSearch(query, this.lastOptions);
  }

  // Reloads the browse-list entries and, if a query is active, re-runs
  // it. Called whenever the index changes: watcher updates, a new
  // entry, a rescan, or a blog-path change. Entries-only: never implies
  // a media rescan (see refreshMedia()).
  refresh(): void {
    void this.pushEntries();
    if (this.view && this.lastQuery.length > 0) {
      void this.runSearch(this.lastQuery, this.lastOptions);
    }
  }

  // Re-scans the media directory and pushes a fresh snapshot, also
  // recomputing localResourceRoots in case the media directory itself
  // moved (blog-path change). Called by the media watcher and the
  // Upload/Refresh Media Library commands.
  async refreshMedia(): Promise<void> {
    if (this.view) {
      const mediaResourceRoots = await this.mediaController.resourceRoots();
      this.view.webview.options = {
        enableScripts: true,
        localResourceRoots: mediaResourceRoots,
      };
    }
    await this.mediaController.pushState();
  }

  async uploadMedia(): Promise<void> {
    await this.mediaController.upload();
  }

  private handleMessage(raw: unknown): void {
    const entryMessage = validateWebviewMessage(raw);
    if (entryMessage) {
      void this.dispatchMessage(entryMessage);
      return;
    }
    // Entry and media message vocabularies are disjoint (media types
    // are "media"-prefixed), so trying the entry validator first is
    // unambiguous -- anything it rejects is tried against the media
    // validator next.
    const mediaMessage = validateMediaMessage(raw);
    if (mediaMessage) {
      this.mediaController.dispatch(mediaMessage).catch((error) => {
        console.error(`VS Journal: media "${mediaMessage.type}" action failed:`, error);
        this.post({
          type: "mediaStatus",
          message: "That action could not be completed.",
          isError: true,
        });
      });
    }
  }

  private async dispatchMessage(message: InboundWebviewMessage): Promise<void> {
    switch (message.type) {
      case "search": {
        this.lastQuery = message.query;
        this.lastOptions = {
          matchCase: message.matchCase,
          wholeWord: message.wholeWord,
          useRegex: message.useRegex,
        };
        await this.runSearch(message.query, this.lastOptions);
        return;
      }
      case "clear":
        this.lastQuery = "";
        return;
      case "open":
        await this.deps.openEntry(message.path);
        return;
      case "tag":
        await this.searchByTag(message.tag);
        return;
      case "newEntry":
        await this.deps.createNewEntry();
        return;
      case "ready":
        await this.handleWebviewReady();
        return;
    }
  }

  // The webview posts "ready" once its script has registered its
  // message listener; anything sent earlier would have been dropped by
  // the still-loading page, so outbound messages queue until then.
  // Shared by both halves of the combined webview: one handshake, one
  // outbox.
  private async handleWebviewReady(): Promise<void> {
    this.webviewReady = true;
    const queued = this.outbox;
    this.outbox = [];
    for (const message of queued) {
      this.send(message);
    }
    void this.pushEntries();
    if (this.pendingFocus) {
      this.pendingFocus = false;
      this.send({ type: "focus" });
    }
    void this.mediaController.pushState();
  }

  private async pushEntries(): Promise<void> {
    const index = this.deps.getIndex();
    if (!index) {
      this.post({ type: "entries", groups: [], total: 0 });
      return;
    }
    try {
      const entries = await index.listEntries();
      this.post({
        type: "entries",
        groups: groupEntriesByYearMonth(entries),
        total: entries.length,
      });
    } catch (error) {
      console.error("VS Journal: failed to load entries:", error);
      this.post({ type: "entries", groups: [], total: 0 });
    }
  }

  private async runSearch(query: string, options: SearchOptions): Promise<void> {
    const index = this.deps.getIndex();
    if (!index) {
      this.post({
        type: "error",
        message: "The journal index is not ready yet. Try again in a moment.",
      });
      return;
    }
    try {
      const response: SearchResponse = await index.search(query, options);
      this.post({
        type: "results",
        query: response.query,
        entries: response.entries,
        tags: response.tags,
      });
    } catch (error) {
      if (error instanceof InvalidSearchPatternError) {
        this.post({ type: "error", message: "Invalid regular expression." });
        return;
      }
      console.error("VS Journal search failed:", error);
      this.post({
        type: "error",
        message: "Search failed. Run 'Rescan All Entries' and try again.",
      });
    }
  }

  private post(message: Record<string, unknown>): void {
    if (!this.view) {
      return;
    }
    if (!this.webviewReady) {
      // Only the latest queued message of a given type matters once
      // "ready" arrives (e.g. repeated refresh() calls during startup
      // each queue a fresh "entries" snapshot) -- replace rather than
      // accumulate so the outbox can't grow unbounded before the
      // webview finishes loading.
      const index = this.outbox.findIndex((queued) => queued.type === message.type);
      if (index >= 0) {
        this.outbox[index] = message;
      } else {
        this.outbox.push(message);
      }
      return;
    }
    this.send(message);
  }

  private send(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }
}

// The webview page: restrictive CSP (no remote content; images load
// only from this webview's own resource origin, scoped by
// localResourceRoots to the live media directory; the inline style and
// script are authorized only by nonce), VS Code theme variables
// throughout, and DOM-API rendering with textContent so database-,
// Markdown-, and filesystem-derived text is never parsed as HTML.
function buildSearchHtml(webview: vscode.Webview): string {
  const nonce = crypto.randomBytes(16).toString("base64");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src ${webview.cspSource}; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Journal</title>
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  body {
    padding: 0;
    margin: 0;
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
  }
  .search-bar {
    display: flex;
    gap: 4px;
    padding: 8px 8px 4px 8px;
    position: sticky;
    top: 0;
    background: var(--vscode-sideBar-background);
    z-index: 1;
  }
  .search-input-wrap {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  #query {
    width: 100%;
    padding: 4px 76px 4px 6px;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    outline-color: var(--vscode-focusBorder);
  }
  #query::placeholder { color: var(--vscode-input-placeholderForeground); }
  .toggles {
    display: flex;
    gap: 2px;
    position: absolute;
    top: 2px;
    right: 2px;
    bottom: 2px;
  }
  .toggle {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 20px;
    padding: 0;
    color: var(--vscode-input-foreground);
    background: transparent;
    border: 1px solid transparent;
    border-radius: 2px;
    font-size: 0.85em;
    font-family: var(--vscode-font-family);
    cursor: pointer;
  }
  .toggle:hover { background: var(--vscode-inputOption-hoverBackground); }
  .toggle[aria-pressed="true"] {
    color: var(--vscode-inputOption-activeForeground, var(--vscode-foreground));
    background: var(--vscode-inputOption-activeBackground);
    border-color: var(--vscode-inputOption-activeBorder, transparent);
  }
  #clear {
    padding: 4px 8px;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    cursor: pointer;
  }
  #clear:hover { background: var(--vscode-toolbar-hoverBackground); }
  #clear:focus-visible, .toggle:focus-visible, .entry:focus-visible,
  .chip:focus-visible, .cta:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: 1px;
  }
  #status {
    padding: 6px 10px 2px 10px;
    color: var(--vscode-descriptionForeground);
  }
  #status.error { color: var(--vscode-errorForeground); }
  #tags {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    padding: 2px 8px;
  }
  #tags:empty, #status:empty { display: none; }
  .chip {
    padding: 1px 8px;
    font-size: 0.9em;
    color: var(--vscode-badge-foreground);
    background: var(--vscode-badge-background);
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  #results, #browse {
    list-style: none;
    margin: 0;
    padding: 4px 0;
  }
  #browse:empty, #results:empty { display: none; }
  .entry {
    display: block;
    width: 100%;
    padding: 4px 10px;
    color: inherit;
    font: inherit;
    text-align: left;
    background: transparent;
    border: none;
    cursor: pointer;
  }
  .entry:hover { background: var(--vscode-list-hoverBackground); }
  .entry .title {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .entry .snippet {
    overflow: hidden;
    max-height: 3em;
    color: var(--vscode-descriptionForeground);
    font-size: 0.92em;
  }
  .entry .snippet mark {
    color: var(--vscode-editor-findMatchHighlightForeground, inherit);
    background: var(--vscode-editor-findMatchHighlightBackground, rgba(234, 92, 0, 0.33));
  }
  .entry .meta {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    align-items: center;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
  }
  .entry .meta .path {
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  details.year, details.month { border: none; }
  details.year > summary, details.month > summary {
    padding: 3px 10px;
    cursor: pointer;
    list-style: revert;
  }
  details.year > summary { font-weight: 600; }
  details.month { margin-left: 12px; }
  details summary:focus-visible {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  #empty-state {
    padding: 16px 10px;
    color: var(--vscode-descriptionForeground);
  }
  #empty-state:empty { display: none; }
  .cta {
    color: var(--vscode-textLink-foreground);
    background: none;
    border: none;
    padding: 0;
    font: inherit;
    cursor: pointer;
    text-decoration: underline;
  }
  .cta:hover { color: var(--vscode-textLink-activeForeground); }
${MEDIA_STYLES}
</style>
</head>
<body>
  <div class="search-bar">
    <div class="search-input-wrap">
      <input id="query" type="text" placeholder="Search journal..." aria-label="Search journal entries" autocomplete="off" spellcheck="false">
      <div class="toggles">
        <button id="toggle-case" class="toggle" data-toggle="matchCase" type="button" aria-pressed="false" aria-label="Match Case" title="Match Case">Aa</button>
        <button id="toggle-word" class="toggle" data-toggle="wholeWord" type="button" aria-pressed="false" aria-label="Match Whole Word" title="Match Whole Word">ab</button>
        <button id="toggle-regex" class="toggle" data-toggle="useRegex" type="button" aria-pressed="false" aria-label="Use Regular Expression" title="Use Regular Expression">.*</button>
      </div>
    </div>
    <button id="clear" title="Clear search" aria-label="Clear search">Clear</button>
  </div>
  <div id="status" role="status"></div>
  <div id="tags" role="list" aria-label="Matching tags"></div>
  <ul id="results" aria-label="Search results"></ul>
  <div id="browse" aria-label="Journal entries"></div>
  <div id="empty-state"></div>
${MEDIA_BODY_HTML}
<script nonce="${nonce}">
${MEDIA_SCRIPT}
${WEBVIEW_SCRIPT}
</script>
</body>
</html>`;
}

// Plain-JS webview script. Rendering rule: every dynamic string is
// assigned through textContent; snippet highlight markers (control
// characters \\u0001/\\u0002 from the index) are converted to <mark>
// elements by splitting, never by HTML parsing. Owns the single
// acquireVsCodeApi() instance and the single persisted state blob for
// the whole webview (entries fields at the top level, media fields
// nested under state.media -- see initMedia in mediaView.ts's
// MEDIA_SCRIPT) and the single "ready" handshake shared by both halves.
const WEBVIEW_SCRIPT = `
(function () {
  var vscode = acquireVsCodeApi();
  var MARK_START = String.fromCharCode(1);
  var MARK_END = String.fromCharCode(2);
  var input = document.getElementById("query");
  var clearButton = document.getElementById("clear");
  var statusEl = document.getElementById("status");
  var tagsEl = document.getElementById("tags");
  var resultsEl = document.getElementById("results");
  var browseEl = document.getElementById("browse");
  var emptyStateEl = document.getElementById("empty-state");
  var toggleButtons = Array.prototype.slice.call(document.querySelectorAll(".toggle"));
  var state = vscode.getState() || {
    query: "",
    toggles: { matchCase: false, wholeWord: false, useRegex: false },
    response: null,
    groups: [],
    total: 0,
    loaded: false,
    expanded: {},
  };
  state.toggles = state.toggles || { matchCase: false, wholeWord: false, useRegex: false };
  state.expanded = state.expanded || {};

  function save() {
    vscode.setState(state);
  }

  var media = initMedia(vscode, state, save);

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.className = isError ? "error" : "";
  }

  function clearResults() {
    tagsEl.textContent = "";
    resultsEl.textContent = "";
  }

  function renderToggles() {
    toggleButtons.forEach(function (button) {
      var key = button.getAttribute("data-toggle");
      button.setAttribute("aria-pressed", state.toggles[key] ? "true" : "false");
    });
  }

  function renderSnippet(container, snippet) {
    var rest = snippet;
    while (rest.length > 0) {
      var startAt = rest.indexOf(MARK_START);
      if (startAt < 0) {
        container.appendChild(document.createTextNode(rest));
        return;
      }
      if (startAt > 0) {
        container.appendChild(document.createTextNode(rest.slice(0, startAt)));
      }
      rest = rest.slice(startAt + 1);
      var endAt = rest.indexOf(MARK_END);
      if (endAt < 0) {
        container.appendChild(document.createTextNode(rest));
        return;
      }
      var mark = document.createElement("mark");
      mark.textContent = rest.slice(0, endAt);
      container.appendChild(mark);
      rest = rest.slice(endAt + 1);
    }
  }

  function makeTagChip(tag, count) {
    var chip = document.createElement("button");
    chip.className = "chip";
    chip.setAttribute("role", "listitem");
    chip.textContent = count === undefined ? tag : tag + " (" + count + ")";
    chip.setAttribute("aria-label", "Search entries tagged " + tag);
    chip.addEventListener("click", function () {
      input.value = "tag:" + tag;
      submit();
    });
    return chip;
  }

  function makeEntryButton(entry, withSnippet) {
    var button = document.createElement("button");
    button.className = "entry";
    button.setAttribute("aria-label", "Open entry " + entry.title);

    var title = document.createElement("div");
    title.className = "title";
    title.textContent = entry.title;
    button.appendChild(title);

    if (withSnippet && entry.snippet && entry.snippet.length > 0) {
      var snippet = document.createElement("div");
      snippet.className = "snippet";
      renderSnippet(snippet, entry.snippet);
      button.appendChild(snippet);
    }

    var meta = document.createElement("div");
    meta.className = "meta";
    var date = document.createElement("span");
    date.textContent = String(entry.date).slice(0, 10);
    meta.appendChild(date);
    var pathEl = document.createElement("span");
    pathEl.className = "path";
    pathEl.textContent = entry.path;
    meta.appendChild(pathEl);
    button.appendChild(meta);

    button.addEventListener("click", function () {
      vscode.postMessage({ type: "open", path: entry.path });
    });
    return button;
  }

  function renderEntry(entry) {
    var item = document.createElement("li");
    item.appendChild(makeEntryButton(entry, true));

    if (entry.tags && entry.tags.length > 0) {
      var tagRow = document.createElement("div");
      tagRow.className = "meta";
      tagRow.style.padding = "0 10px 4px 10px";
      for (var i = 0; i < entry.tags.length; i++) {
        tagRow.appendChild(makeTagChip(entry.tags[i]));
      }
      item.appendChild(tagRow);
    }
    return item;
  }

  function renderResponse(response) {
    clearResults();
    if (response.entries.length === 0 && response.tags.length === 0) {
      setStatus('No results for "' + response.query + '".', false);
      return;
    }
    setStatus("", false);
    for (var t = 0; t < response.tags.length; t++) {
      tagsEl.appendChild(makeTagChip(response.tags[t].tag, response.tags[t].count));
    }
    for (var e = 0; e < response.entries.length; e++) {
      resultsEl.appendChild(renderEntry(response.entries[e]));
    }
  }

  function renderError(message) {
    clearResults();
    setStatus(message, true);
  }

  function makeDetails(className, summaryText, open, onToggle) {
    var details = document.createElement("details");
    details.className = className;
    details.open = !!open;
    var summary = document.createElement("summary");
    summary.textContent = summaryText;
    details.appendChild(summary);
    details.addEventListener("toggle", function () {
      onToggle(details.open);
    });
    return details;
  }

  function renderBrowse() {
    browseEl.textContent = "";
    for (var y = 0; y < state.groups.length; y++) {
      var yearGroup = state.groups[y];
      var yearKey = yearGroup.year;
      var yearDetails = makeDetails("year", yearGroup.year, state.expanded[yearKey], function (key) {
        return function (open) {
          state.expanded[key] = open;
          save();
        };
      }(yearKey));

      for (var m = 0; m < yearGroup.months.length; m++) {
        var monthGroup = yearGroup.months[m];
        var monthKey = yearKey + "-" + monthGroup.month;
        var monthDetails = makeDetails(
          "month",
          monthGroup.label + " (" + monthGroup.entries.length + ")",
          state.expanded[monthKey],
          function (key) {
            return function (open) {
              state.expanded[key] = open;
              save();
            };
          }(monthKey)
        );

        var list = document.createElement("ul");
        for (var i = 0; i < monthGroup.entries.length; i++) {
          var li = document.createElement("li");
          li.appendChild(makeEntryButton(monthGroup.entries[i], false));
          list.appendChild(li);
        }
        monthDetails.appendChild(list);
        yearDetails.appendChild(monthDetails);
      }

      browseEl.appendChild(yearDetails);
    }
  }

  function renderEmptyState() {
    emptyStateEl.textContent = "";
    if (!state.loaded || state.total > 0) {
      return;
    }
    var message = document.createElement("div");
    message.textContent = "No blog entries yet. ";
    var cta = document.createElement("button");
    cta.className = "cta";
    cta.type = "button";
    cta.textContent = "Create your first entry";
    cta.addEventListener("click", function () {
      vscode.postMessage({ type: "newEntry" });
    });
    message.appendChild(cta);
    emptyStateEl.appendChild(message);
  }

  function renderIdleView() {
    clearResults();
    setStatus("Search titles, content, and tags. Use tag:name to search tags only.", false);
    renderBrowse();
    renderEmptyState();
  }

  function render() {
    renderToggles();
    if (state.query.length === 0) {
      renderIdleView();
      return;
    }
    browseEl.textContent = "";
    emptyStateEl.textContent = "";
    if (state.response) {
      renderResponse(state.response);
    }
  }

  // Safety net: the extension host always responds (success or error),
  // but if a stale webview ever talks to a mismatched extension build
  // (e.g. an un-reloaded window after a recompile) a response could go
  // missing. Without this, "Searching..." would hang forever with no
  // way out.
  var SEARCH_TIMEOUT_MS = 10000;
  var searchTimeoutHandle = null;

  function clearSearchTimeout() {
    if (searchTimeoutHandle) {
      clearTimeout(searchTimeoutHandle);
      searchTimeoutHandle = null;
    }
  }

  function armSearchTimeout(query) {
    clearSearchTimeout();
    searchTimeoutHandle = setTimeout(function () {
      if (state.query === query) {
        // Not renderError(): a slow regex/whole-journal scan is normal,
        // not a failure, so this stays neutral status text rather than
        // the red error styling.
        setStatus(
          "Still searching -- this can take longer for a large journal or a broad regex. If it never finishes, try 'Developer: Reload Window' and search again.",
          false
        );
      }
    }, SEARCH_TIMEOUT_MS);
  }

  function submit() {
    var query = input.value.trim();
    state.query = query;
    save();
    if (query.length === 0) {
      clearSearchTimeout();
      state.response = null;
      save();
      render();
      vscode.postMessage({ type: "clear" });
      return;
    }
    setStatus("Searching...", false);
    clearResults();
    browseEl.textContent = "";
    emptyStateEl.textContent = "";
    armSearchTimeout(query);
    vscode.postMessage({
      type: "search",
      query: query,
      matchCase: !!state.toggles.matchCase,
      wholeWord: !!state.toggles.wholeWord,
      useRegex: !!state.toggles.useRegex,
    });
  }

  function clearAll() {
    clearSearchTimeout();
    input.value = "";
    state.query = "";
    state.response = null;
    save();
    render();
    vscode.postMessage({ type: "clear" });
  }

  var INBOUND_HANDLERS = {
    results: function (message) {
      if (message.query !== state.query) {
        return;
      }
      clearSearchTimeout();
      state.response = message;
      save();
      render();
    },
    error: function (message) {
      clearSearchTimeout();
      renderError(message.message);
    },
    focus: function () {
      input.focus();
      input.select();
    },
    setQuery: function (message) {
      input.value = message.query;
      state.query = message.query;
      save();
      setStatus("Searching...", false);
      clearResults();
      armSearchTimeout(message.query);
    },
    cleared: function () {
      clearAll();
    },
    entries: function (message) {
      state.groups = message.groups;
      state.total = message.total;
      state.loaded = true;
      save();
      if (state.query.length === 0) {
        renderIdleView();
      } else {
        renderEmptyState();
      }
    },
  };
  Object.assign(INBOUND_HANDLERS, media.handlers);

  window.addEventListener("message", function (event) {
    var message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }
    var handler = INBOUND_HANDLERS[message.type];
    if (handler) {
      handler(message);
    }
  });

  input.addEventListener("keydown", function (event) {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });
  clearButton.addEventListener("click", clearAll);

  toggleButtons.forEach(function (button) {
    button.addEventListener("click", function () {
      var key = button.getAttribute("data-toggle");
      state.toggles[key] = !state.toggles[key];
      save();
      renderToggles();
      if (state.query.length > 0) {
        submit();
      }
    });
  });

  if (state.query) {
    input.value = state.query;
  }
  render();
  vscode.postMessage({ type: "ready" });
})();
`;
