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

Not yet implemented: drag-and-drop image support into the `assets/` folder.

## Directory Structure

```text
blog/
├── assets/              # Image and media files
├── entries/             # Blog entries organized by date
│   ├── .vs-journal/     # Generated search index (keep out of Git)
│   │   └── index.sqlite3
│   └── YYYY/            # Year folders
│       └── MM/          # Month folders
│           └── DD/      # Day folders
│               └── title.md  # Individual entries
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
- Results are ranked by full-text relevance (title matches weigh more than
  body matches) and include a highlighted snippet plus date, path, and tags.
- Queries shorter than 3 characters use an indexed database fallback; no
  search ever re-reads the Markdown files.
- `tag:<value>` restricts the search to tag names (case-insensitive
  substring match). Tag chips in results are clickable and run that search.
- Press Enter to search; the Clear button next to the input resets the view
  back to the browse list (also available as `Journal: Clear Search` from
  the Command Palette). `Journal: Search Blog` focuses the search input.

## Git and the generated index

The generated index lives inside your journal, so if the journal is under
version control the database would show up as an untracked directory. On
activation the extension checks whether `.vs-journal/` is ignored in the
enclosing repository and, if not, offers once to append `**/.vs-journal/`
to that repository's root `.gitignore`. Your `.gitignore` is modified only
if you choose the action. If index files were already committed, an ignore
rule does not untrack them; untrack them manually (for example
`git rm -r --cached blog/entries/.vs-journal`).

## Usage

1. Use `Ctrl+Shift+P` and search for "Journal: New Blog Entry"
2. Enter a title for your entry
3. Start writing in the markdown file that opens
4. Your entry will appear in the Journal sidebar's browse list

## Configuration

- `vsJournal.blogPath`: Path to blog directory (default: "./blog")

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
code --install-extension vscode-journal-win32-x64-1.0.0.vsix --force
```

## Releasing

Follow [RELEASING.md](RELEASING.md) for versioning, verification, packaging,
local installation, smoke testing, and tagging.
