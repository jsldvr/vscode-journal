# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
