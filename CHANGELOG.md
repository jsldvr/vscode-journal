# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [2.0.0] - 2026-08-16

### Changed

- **Breaking:** raised the minimum supported VS Code version from 1.74.0 to
  1.125.0 (`engines.vscode`). The extension can no longer be installed on
  older VS Code releases.
- Migrated the ESLint configuration from `.eslintrc.json` to flat config
  (`eslint.config.js`), upgrading `eslint` to ^10.8.1 and
  `@typescript-eslint/eslint-plugin`/`@typescript-eslint/parser` to ^8.67.0.
- Upgraded `typescript` to ^6.0.3, `@types/node` to ^25.9.5, `@types/vscode`
  to 1.125.0, and `lint-staged` to ^16.4.0.

### Removed

- The deprecated `@types/moment` stub package; `moment` ships its own type
  definitions.

## [1.1.0] - 2026-08-16

### Added

- A Media library section built into the single Journal sidebar webview,
  below the entry browse list, for browsing, uploading, and managing files
  under `<blogPath>/media` (a sibling of `entries/`, created lazily on first
  upload). The section has its own pinned toolbar (search, a type filter --
  All/Images/Audio/Video/Documents, Upload, and Refresh) and a responsive
  thumbnail grid with real image previews and labeled placeholders for other
  types.
- An editor-area details view (`vsJournal.mediaDetails`) that opens when a
  media tile is selected, showing a preview, filename, relative path, type,
  size, and last-modified time, plus Copy Path, Open, Reveal in File
  Explorer/Finder, and Delete actions. Selecting another tile reuses the same
  tab; nothing is ever auto-selected on load, refresh, or upload.
- `Journal: Upload Media` and `Journal: Refresh Media Library` commands,
  also available as toolbar buttons in the Media section.
- A recursive file watcher on `media/` that keeps the library in sync with
  files added, changed, deleted, or renamed on disk.
- Collision-safe uploads: colliding filenames are renamed with a numeric
  suffix (`image-2.png`, `image-3.png`, ...) instead of overwriting existing
  files.
- Symlink- and traversal-hardened filesystem handling for the media
  directory: a symlinked media root or a symlinked ancestor between the
  workspace root and the media root is treated as unsafe and disables the
  webview resource root rather than exposing it; individual file resolution
  rejects traversal, absolute paths, non-regular files, and symlinked
  intermediate directories; delete re-validates its target immediately
  before removal to close the TOCTOU window.

## [1.0.0] - 2026-07-26

### Added

- A repository-local SQLite/FTS5 index at `<blog>/entries/.vs-journal/index.sqlite3`
  covering entry metadata, tags, and full-text content (frontmatter excluded),
  with versioned `PRAGMA user_version` migrations, WAL mode, transactional
  updates, activation-time reconciliation, and automatic rebuild when the
  database is missing, corrupt, or written by an incompatible schema version.
- An inline sidebar Search view (webview) with a persistent input, ranked
  full-text results with highlighted snippets, date/path/tag metadata,
  clickable tag chips, keyboard-accessible controls, and idle/loading/
  no-results/error states. Search is case-insensitive substring matching via
  the FTS5 trigram tokenizer; `tag:<value>` remains a relational tag query.
- A one-time offer to add `**/.vs-journal/` to the workspace `.gitignore`
  when the journal's repository does not already ignore the generated index.
- Platform-specific packaging scripts (`package:<target>`) that stage the
  matching `sqlite3` N-API prebuilt binary before `vsce package --target`,
  plus a CI job that packages and verifies every supported target.
- Contributor guidance covering repository structure, commands, testing, and agent workflows.
- GitHub Actions checks for compilation, linting, and unit tests on pushes and pull requests.
- A default pull request template and structured bug and feature issue forms.
- Weekly grouped Dependabot updates for npm dependencies.
- Pre-commit type checking and staged TypeScript linting with Husky and lint-staged.
- A comprehensive test system under `test/` with unit, VS Code Extension Host
  acceptance, property, bounded torture, mutation, and aggregate QA suites.
- Automated GitHub releases driven by the `package.json` SemVer, with
  platform-specific VSIX artifacts, changelog release notes, contributor
  attribution, duplicate-release protection, and prerelease support.

### Changed

- The explorer, welcome state, entry creation, file watchers, and rescans now
  read and write the SQLite index instead of `entries/map.json`. Existing
  `map.json` files are left untouched but are no longer required or updated.
- `Journal: Search Blog` now reveals and focuses the persistent Search view
  input instead of opening a modal input box.
- Search results are ranked by full-text relevance with snippets instead of
  raw match counts, and no query re-reads Markdown files from disk.
- The VS Code development launch now installs dependencies before starting the compiler watcher.
- The npm package identifier is now `vscode-journal`, and the extension version
  is `1.0.0`.

### Removed

- The map.json-based search TreeDataProvider and the mapStore module.

## [0.1.0]

Initial repository version. No release tag or publication record is present.

### Added

- Markdown journal entries organized in year, month, and day directories.
- Activity Bar views for browsing entries and performing full-text search.
- Commands for creating, opening, searching, rescanning, and configuring journals.
- A JSON entry index with storage and path-safety handling.
- Unit and VS Code Extension Host test infrastructure.
