# Release Process

This procedure creates and verifies a local VSIX release from `main`. It does
not publish to the VS Code Marketplace or create a GitHub release.

Replace `X.Y.Z` in every command with the intended semantic version.

## Prerequisites

- Node.js, npm, Git, and the VS Code `code` CLI are available.
- You have explicit authorization to create and push the release commit and tag.
- The release version and scope have been agreed before changing files.

## Native Dependency

The extension bundles `sqlite3` (pinned exactly in `package.json`), an
N-API native module. One prebuilt binary per platform is ABI-stable across
VS Code's Electron and Node versions, but each VSIX must contain the binary
for its target platform, so releases are **platform-specific VSIXes** built
with `vsce package --target`.

`npm run package:<target>` stages the correct prebuilt binary (downloaded
from the pinned sqlite3 GitHub release by
`scripts/stage-sqlite3-prebuild.js`) and then packages that target.

Supported targets (matching published sqlite3 napi-v6 prebuilds):

| vsce target  | Runs on                                                 |
|--------------|---------------------------------------------------------|
| win32-x64    | Windows x64                                             |
| darwin-x64   | macOS Intel                                             |
| darwin-arm64 | macOS Apple Silicon                                     |
| linux-x64    | Linux x64 (also Remote SSH/WSL/dev containers on glibc) |
| linux-arm64  | Linux arm64                                             |
| alpine-x64   | Alpine/musl x64 containers                              |
| alpine-arm64 | Alpine/musl arm64 containers                            |

`win32-arm64` has no published sqlite3 prebuild and cannot be released
without building from source; it is currently unsupported. After staging a
foreign platform's binary, run `npm run stage:sqlite3` (no argument) to
restore the binary for your own machine before running tests locally.

## 1. Prepare the Repository

```bash
git switch main
git pull --ff-only
git status --short
npm ci
```

Stop if `git status --short` prints anything. Do not release from a feature
branch or with unrelated changes present.

## 2. Set the Version and Changelog

```bash
npm version --no-git-tag-version X.Y.Z
```

In `CHANGELOG.md`:

1. Move the current Unreleased entries under `## [X.Y.Z] - YYYY-MM-DD`.
2. Add a new `## [Unreleased]` section above the release.
3. Omit empty change-category headings.
4. Describe only changes included in the release.

Review the release metadata:

```bash
git diff -- package.json package-lock.json CHANGELOG.md
```

## 3. Verify the Release

Run the same checks required by CI:

```bash
npm run release:check
```

Then run the VS Code Extension Host suite from a graphical desktop session:

```bash
npm run test:integration
```

Stop on any failure. Do not treat an unavailable display as a passing
integration test.

## 4. Build and Install the VSIX

Build every supported platform target (each stages its own native binary):

```bash
npm run package:win32-x64
npm run package:darwin-x64
npm run package:darwin-arm64
npm run package:linux-x64
npm run package:linux-arm64
npm run package:alpine-x64
npm run package:alpine-arm64
```

Verify each produced VSIX contains the native binary before distributing it
(CI performs the same check):

```bash
unzip -l <file>.vsix | grep node_sqlite3.node
```

Install the VSIX for your own platform locally:

```bash
code --install-extension <file>.vsix --force
```

Restore your local development binary afterwards:

```bash
npm run stage:sqlite3
```

In a disposable workspace, confirm that:

- The VS Journal Activity Bar view opens.
- A journal directory can be selected.
- An entry can be created, displayed in the tree, and found by search.
- Rescanning preserves the entry index.

## 5. Commit and Tag

Review `git status --short`; only the version and changelog files should be
tracked release changes. The VSIX is ignored by Git.

Agents must stop here unless the user explicitly authorized the release commit,
tag, and push. With that authorization:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release vX.Y.Z"
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin main
git push origin vX.Y.Z
```

Marketplace publication and GitHub release creation require separate
authorization and are not part of this procedure.
