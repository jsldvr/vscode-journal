# Journal

A simple blog extension for VS Code that stores entries in markdown format with a file-based structure.

## Features

- **Create Blog Entries**: Easy creation of new blog entries with markdown support
- **Organized Storage**: Entries are organized by year/month/day structure
- **Single Sidebar View**: A persistent search field pinned at the top, with the
  Year → Month → Entry browse list directly below it in the same panel
- **Inline Search**: Ranked, snippeted results, with Match Case / Whole Word /
  Regex toggles
- **SQLite Index**: A repository-local SQLite/FTS5 database indexes titles, content, and tags
- Entries open as plain markdown, so VS Code's own markdown preview and editing
  tools apply
- **Media Library**: A Media section built into the same Journal sidebar view,
  below the entry browse list, for browsing, uploading, and managing images,
  audio, video, and other files stored in the media directory (`media/` by
  default, configurable via `vsJournal.mediaPath`). One click on a tile inserts
  correctly formatted Markdown for the file at the cursor in the active journal
  entry.

## Directory Structure

```text
blog/
├── entries/             # Blog entries organized by date
│   ├── .vs-journal/     # Generated search index (keep out of Git)
│   │   └── index.sqlite3
│   └── YYYY/            # Year folders
│       └── MM/          # Month folders
│           └── DD/      # Day folders
│               └── title.md  # Individual entries
└── media/                # Images, audio, video, and other files
                          # (default location; see vsJournal.mediaPath)
```

Markdown is the source of truth. Everything under `entries/.vs-journal/` is
a disposable, generated index: it is created on activation, kept current by
file watchers, reconciled against the Markdown on startup, and rebuilt from
scratch by the "Rescan All Entries" command or whenever it is missing,
corrupt, or written by an incompatible schema version.

Older journals may still contain an `entries/map.json` file from previous
versions. It is no longer read or written and can be deleted whenever you
like; the extension leaves it untouched.

## Search and browsing

The Journal sidebar is a single view: a persistent search input (with Match
Case / Whole Word / Regex toggles) pinned at the top, and the entry list
directly below it in the same panel -- no separate tree view, no collapsible
section header between them.

- With an empty query, the panel shows all entries grouped by Year → Month
  (collapsed by default; click to expand). With zero entries in the journal,
  it shows a "Create your first entry" prompt instead.
- By default, queries are matched as literal, case-insensitive substrings
  across entry titles, Markdown content (frontmatter excluded), and tags,
  backed by an FTS5 trigram index. FTS query operators (`AND`, `NEAR`,
  quotes, and so on) are treated as plain text, not syntax.
- Enabling Match Case, Whole Word, or Regex switches to an in-memory scan of
  every entry's title and body using the equivalent `RegExp`, matching how
  VS Code's own Search panel behaves. An invalid regex shows an inline error
  instead of failing silently. These toggles do not affect `tag:` queries.
- The Match Case / Whole Word / Regex scan runs on a worker thread with a
  fixed 2-second budget per search. A pattern that exceeds it (for example a
  regex with catastrophic backtracking such as `(a+)+$` over a long line) is
  stopped and reported as an inline "Regex search timed out" error; the editor
  stays responsive and the next search works normally. Simplify the expression
  or turn off the Regex toggle. Rebuilding the index does not help here.
- Results are ranked by full-text relevance (title matches weigh more than
  body matches) and include a highlighted snippet plus date, path, and tags.
- Queries shorter than 3 characters use an indexed database fallback; no
  search ever re-reads the Markdown files.
- `tag:<value>` restricts the search to tag names (case-insensitive
  substring match). Tag chips in results are clickable and run that search.
- Press Enter to search; the Clear button next to the input resets the view
  back to the browse list (also available as `Journal: Clear Search` from
  the Command Palette). `Journal: Search Blog` focuses the search input.

## Media library

The Journal sidebar view has a Media section below the entry browse list, in
the same panel and the same webview -- there is still only one contributed
view in the activity bar. It shows the contents of the media directory,
which is `vsJournal.mediaPath` resolved against the configured blog
directory (default `media`, i.e. a sibling of `entries/`). The directory is
created automatically the first time you upload a file -- it is never
created merely by opening the extension, by opening the folder picker, or
by changing the setting.

The Media heading shows the current location as a workspace-relative path,
for example `Media: blog/assets` (a long path is truncated with the full
label on hover). It reflects `vsJournal.blogPath` and `vsJournal.mediaPath`
and updates whenever either changes; it reads `Media: unavailable` when no
safe directory can be resolved. A valid but not-yet-created directory still
shows its configured path -- displaying the path never creates it.

The media directory must stay within the configured blog directory. A
`vsJournal.mediaPath` value that is absolute or escapes the blog directory
(for example `../shared`) is refused: the Media section reports an
unavailable state rather than reading, watching, or writing outside the
blog. Run `Journal: Set Media Directory` to pick a folder inside the blog
directory; the selection is stored as a portable, forward-slash
blog-relative path at Workspace scope (matching `vsJournal.blogPath`), and a
folder outside the blog directory is rejected with an error that leaves the
setting unchanged.

- A toolbar (search field, a type filter -- All / Images / Audio / Video /
  Documents/Other -- an Upload button, and a Refresh button) stays pinned to
  the top of the Media section as you scroll within it.
- Files render as a responsive thumbnail grid: images show real previews,
  everything else shows a labeled placeholder. Search matches filenames and
  paths case-insensitively; results sort newest-modified first.
- Each tile has two actions. The primary action -- clicking the thumbnail, or
  activating it with Enter or Space -- inserts the file as Markdown at every
  cursor in the active journal entry, without opening or focusing any other
  tab. An image inserts `![alt text](media/image.png)`; any other file inserts
  `[file.pdf](media/file.pdf)` using the file's own name as the link label. The
  `alt text` is a snippet placeholder, already selected so you can type the real
  text immediately. The link target uses your configured `vsJournal.mediaPath`
  (so `assets/uploads` produces `assets/uploads/...`), always with forward
  slashes, and is percent-encoded so names with spaces or parentheses (such as
  screenshots) still produce a valid link. Insertion only happens when the
  active editor is a saved Markdown
  file inside the blog `entries/` directory; the media root and the selected
  file are re-checked at that moment. If there is no eligible editor, or the
  media file or root is missing or unsafe, the Media status line reports it and
  nothing is inserted, created, or opened.
- The secondary action is a small **Details** button on each tile. It opens the
  file's details in an editor-area tab -- preview, filename,
  `media/<relative-path>`, type, size, and last-modified time, plus Copy Path,
  Open, Reveal in File Explorer/Finder, and Delete actions -- titled with the
  filename. Choosing Details for another tile reuses and updates that same tab
  rather than opening a new one. Delete always asks for confirmation first, only
  removes the one selected file, and replaces the tab's content with an
  unavailable state afterward. Nothing opens this tab automatically: opening or
  refreshing the sidebar, uploading files, or inserting media never opens or
  changes it.
- Upload opens a multi-select file picker and copies the chosen files into
  `media/`, preserving filenames. A name collision never overwrites an
  existing file -- colliding uploads are renamed with a numeric suffix
  (`image-2.png`, `image-3.png`, ...).
- The Media section watches `media/` recursively and refreshes automatically
  when files are added, changed, deleted, or renamed on disk.
- `Journal: Upload Media` and `Journal: Refresh Media Library` are available
  from the Command Palette; the same actions are also available as buttons
  in the Media toolbar itself. `Journal: Set Media Directory` opens a folder
  picker to change `vsJournal.mediaPath`.
- `Journal: Reveal Media Directory` is in the Journal view toolbar overflow
  menu (the `...` button) and the Command Palette. It reveals the current
  media directory in your OS file manager. A missing, unsafe, or symlinked
  directory is not created or revealed -- the command reports an error
  instead.

## Git and the generated index

The generated index lives inside your journal, so if the journal is under
version control the database would show up as an untracked directory. On
activation the extension checks whether `.vs-journal/` is ignored in the
enclosing repository and, if not, offers once to append `**/.vs-journal/`
to that repository's root `.gitignore`. Your `.gitignore` is modified only
if you choose the action. If index files were already committed, an ignore
rule does not untrack them; untrack them manually (for example
`git rm -r --cached blog/entries/.vs-journal`).

## Entry path safety

The workspace root is the trust anchor. Every path the entry subsystem
touches below it -- the configured blog and `entries` directories, the
generated `entries/.vs-journal/` directory, `index.sqlite3` and its
`.corrupt`/`-wal`/`-shm` siblings, every dated subdirectory, and every
entry `.md` file -- must be a real, non-symlink path of the expected type.
A symbolic link or Windows junction anywhere on the path is rejected, even
when its target stays inside the workspace: linked entry trees are
unsupported, not resolved.

Concretely: entry scanning never follows a linked file or directory and
cannot be led into a directory-link cycle; startup reconciliation drops
index rows for a previously real subtree that has been replaced by a link;
and creating, indexing, opening, or rebuilding an entry revalidates the
physical path immediately before it acts. An unsafe configured root, an
unsafe entry, and an unsafe generated database path each report a
distinct, actionable error and no external file is read or written. Passive
activation never creates missing directories; `New Blog Entry` and the
blog-path setup flow create them deliberately and revalidate each one.
These checks use portable Node filesystem APIs: they stop stable links and
close the practical check/use gap, but they do not claim freedom from an
adversarial filesystem race.

## Usage

1. Use `Ctrl+Shift+P` and search for "Journal: New Blog Entry"
2. Enter a title for your entry
3. Start writing in the markdown file that opens
4. Your entry will appear in the Journal sidebar's browse list

## Configuration

- `vsJournal.blogPath`: Path to blog directory, relative to the workspace
  root (default: "./blog"). Must stay within the workspace and resolve
  through real directories; a symlinked or junctioned path is rejected
  (see "Entry path safety").
- `vsJournal.mediaPath`: Path to the media directory, relative to the
  configured blog directory (default: "media"). Must stay within the blog
  directory; absolute or escaping values are ignored. Change it with
  `Journal: Set Media Directory`.

## Development

Pressing F5 to launch the Extension Development Host automatically runs
`npm install` before compiling, so dependencies stay up to date. If that
pre-launch install fails partway (e.g. no network), commands may appear
to be "not found" because the extension failed to activate — in that
case, run `npm install` manually and try F5 again.

The extension depends on the `sqlite3` npm package, an N-API native module
with prebuilt binaries per platform. `npm ci` downloads the binary for your
development machine automatically. See [RELEASING.md](RELEASING.md) for the
platform-specific packaging story.

## Installation

To build and install the extension locally from source:

```text
npm ci
npm run package:win32-x64   # or your platform target, see RELEASING.md
code --install-extension vscode-journal-<target>-<version>.vsix --force
```

## Releasing

Follow [RELEASING.md](RELEASING.md) for versioning, verification, packaging,
local installation, smoke testing, and tagging.
