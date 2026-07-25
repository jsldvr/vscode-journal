# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```
npm run compile          # tsc -p ./  (src -> out)
npm run watch            # tsc -watch -p ./
npm run lint             # eslint src --ext ts
npm run test:unit        # mocha --ui tdd "out/test/*.test.js" (all unit suites)
npm run test:integration # node ./out/test/runTest.js (launches a real VS Code instance)
npm test                 # test:unit + test:integration
npm run package:<target> # stage sqlite3 prebuild + vsce package --target <target>
npm run stage:sqlite3    # restore the sqlite3 binary for the local machine
```

`pretest` runs `compile` then `lint` automatically before `test:unit`/`test:integration`, so
`npm run compile` first if you're running mocha directly against `out/`.

Run a single unit test by name (compile first, since mocha runs the compiled JS):

```
npm run compile
npx mocha --ui tdd out/test/blogIndex.test.js --timeout 20000 --grep "reconcile"
```

Integration tests (`src/test/suite/`) run inside a downloaded VS Code instance via
`@vscode/test-electron` against a disposable temp workspace created by
`src/test/runTest.ts`. Set `VSCODE_TEST_VERSION=1.74.3` (or any version) to test a
specific VS Code build; the default is stable. They are slow; prefer the unit suites
for logic in `blogIndex.ts` and friends.

Press F5 in VS Code to launch the Extension Development Host. The `Run Extension` launch
config's `preLaunchTask` chain runs `npm: install` before `npm: watch`, so dependencies are
installed automatically. If that pre-launch install fails partway (e.g. no network),
commands may appear "not found" because the extension failed to activate — run
`npm install` manually and retry F5.

`npm: watch` recompiles `src/` -> `out/` in the background on every save, but it does **not**
reload an already-running Extension Development Host window — stale compiled code keeps
running until you trigger `Developer: Reload Window` inside that window (or stop and restart
the F5 debug session). If behavior in the dev host doesn't match what's in `src/`, reload
before assuming there's a bug.

## Architecture

This is a VS Code extension (CommonJS/ES2020, TypeScript strict mode, `rootDir: src` ->
`outDir: out`) that stores blog/journal entries as markdown files under a configurable
`vsJournal.blogPath` directory (default `./blog`). Entries are indexed in a
repository-local SQLite database at `<blog>/entries/.vs-journal/index.sqlite3`
(FTS5 trigram full-text index; WAL mode; busy timeout 5000ms). Markdown is
authoritative; the database is disposable and rebuilt from Markdown whenever it is
missing, corrupt, or has an incompatible `PRAGMA user_version`. Legacy
`entries/map.json` files are no longer read or written.

Source files, by responsibility:

- **`src/extension.ts`** — activation entry point; owns `IndexHost` (opens/reopens/closes
  the database per configuration), registers all commands, wires the single merged
  sidebar webview, and owns the file-watching pipeline (change/create/delete, save, and
  rename events all funnel into the index).
- **`src/blogIndex.ts`** — the database service: connection lifecycle, versioned
  migrations (`MIGRATIONS`, `PRAGMA user_version`), corruption quarantine+rebuild,
  transactional entry/tag/FTS writes (FTS synced by triggers), activation
  reconciliation (path+mtime+size), full rebuild, and all search queries. In-process
  writers are serialized through a promise queue so a rescan and a concurrent watcher
  upsert can never race; cross-process concurrency is handled by SQLite (WAL + busy
  timeout). By default, search treats user input as literal text (quoted FTS phrase;
  trigram gives substring semantics) and queries under 3 characters use a database-only
  LIKE fallback. When `SearchOptions.matchCase`/`wholeWord`/`useRegex` is set, `search()`
  instead scans every entry's title/body in memory with the equivalent `RegExp`
  (`InvalidSearchPatternError` on a bad `useRegex` pattern); these toggles never apply to
  `tag:` queries.
- **`src/searchView.ts`** — `WebviewViewProvider` for the single merged sidebar view: a
  sticky search bar (with Match Case/Whole Word/Regex toggles) at the top, and directly
  below it in the same webview the Year → Month → Entry browse list (empty query), search
  results (active query), or an empty-state "Create your first entry" CTA (zero entries).
  Restrictive CSP with a nonce, DOM/textContent-only rendering. All inbound messages are
  validated by `src/webviewSupport.ts`. There is deliberately only one contributed view
  under the `vsJournal` container — VS Code only renders a collapsible section header
  when a container has more than one view, so this is what keeps the sidebar a single
  panel with no accordion.
- **`src/entryGrouping.ts`** — pure, vscode-free helper that groups `BlogEntry[]` into
  Year → Month buckets for `searchView.ts`'s browse list; kept free of vscode imports so
  the unit suite can exercise it directly.
- **`src/frontmatter.ts`** — regex-based frontmatter parser shared by watcher,
  reconciliation, and rescan paths; the returned body excludes the frontmatter block so
  it is never indexed as content.
- **`src/pathUtils.ts`** — `isPathInside` (path-traversal guard), `normalizeEntryPath`
  (forward-slash storage form), `createUniqueFile` (exclusive create with retry).
- **`src/gitignoreCore.ts` / `src/gitignoreGuard.ts`** — pure gitignore rule logic and
  the one-time VS Code offer to add `**/.vs-journal/` to the workspace `.gitignore`.
- **`src/types.ts`** — the shared `BlogEntry` shape.

### Data flow / synchronization

Three independent triggers mutate the index, all funneled through `blogIndex.ts`'s
write queue:

1. `vsJournal.newEntry` creates the file and calls `upsertFromFile` directly.
2. A `FileSystemWatcher` on `<blogPath>/entries/**/*.md` (plus `onDidSaveTextDocument`
   and `onDidRenameFiles` listeners) calls `upsertFromFile` / `removeByRelativePath`.
   Renames are handled as delete+create.
3. `vsJournal.rescanEntries` calls `rebuildAll`, which scans inside the write queue and
   replaces everything in one transaction.

Activation runs `reconcile()` (insert new, reindex changed by mtime/size, drop
missing, skip unchanged). Changing `vsJournal.blogPath` at runtime closes and reopens
the database, rebinds the watcher, and refreshes all views.

Entry paths are stored normalized to forward slashes; comparisons against legacy
backslash paths resolve to the same row.

### Notable constraints

- `isPathInside` / `BlogIndex.resolveEntryPath` must be reused (not reimplemented) for
  any new code that resolves a path derived from `blogPath`, the database, or entry
  input. Never resolve or open an indexed path outside the entries directory.
- `sqlite3` is pinned exactly (N-API prebuilds are the compatibility story across
  VS Code versions). Do not swap it or unpin it without re-running the packaging
  matrix. `engines.vscode` must not be raised casually.
- Everything under `.vs-journal/` is generated; never commit it (dev repo `.gitignore`
  covers it) and never store non-rebuildable data there.
- Do not hand-edit files under `out/` — it's compiled output (`tsc`); make changes in `src/`.
