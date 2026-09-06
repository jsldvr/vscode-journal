# Release Process

This procedure prepares and verifies a release from `main`. After the release
change reaches `main`, `.github/workflows/release.yml` runs the complete QA
gate plus minimum-version Extension Host acceptance, creates the Git tag,
builds every supported VSIX, and publishes the GitHub release. It does not
publish to the VS Code Marketplace; Marketplace publication remains
separately authorized and is not automated by this workflow.

Pull requests are gated separately by `.github/workflows/ci.yml`. Its single
aggregate job **`CI Required`** covers the full QA gate, acceptance against
both the minimum (`1.125.0`) and current stable VS Code, and the
seven-target package matrix; it is the only status check the `main` branch
ruleset needs to require.

Replace `X.Y.Z` in every command with the intended semantic version. Valid
prerelease versions such as `1.0.1-rc-1` and `1.0.1-beta` are supported.

## Prerequisites

- Node.js, npm, Git, and the VS Code `code` CLI are available.
- The release version and scope have been agreed before changing files.
- The release change will be reviewed and merged into `main`.

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

The changelog heading must match the package version exactly. For example:

```text
## [1.0.1-rc-1] - YYYY-MM-DD
```

Review the release metadata:

```bash
git diff -- package.json package-lock.json CHANGELOG.md
```

## 3. Verify the Release

Run the complete QA gate that CI and the release workflow require:

```bash
npm run release:check
```

`release:check` is now an alias for `test:qa`: compile, lint, unit, property,
release-metadata, and the stable Extension Host acceptance suite. Run it from
a graphical desktop session, or under `xvfb-run -a` on Linux, so the
Extension Host can launch.

Then run the acceptance suite against the minimum supported VS Code:

```bash
VSCODE_TEST_VERSION=1.125.0 npm run test:acceptance
```

Stop on any failure. Do not treat an unavailable display as a passing
acceptance test.

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

- The Journal Activity Bar view opens.
- A journal directory can be selected.
- An entry can be created, displayed in the tree, and found by search.
- Rescanning preserves the entry index.

## 5. Merge the Release Change

Review `git status --short`; only the version and changelog files should be
tracked release changes. The VSIX is ignored by Git.

Commit the version and changelog on a branch, push it, and merge it through the
normal pull request process:

```bash
git add package.json package-lock.json CHANGELOG.md
git commit -m "Release vX.Y.Z"
git push
```

Do not create or push the version tag manually. On the push to `main`, the
release workflow:

1. Reads and validates the version from `package.json`.
2. Exits successfully when that version tag or release already exists, with
   all downstream verification, packaging, and release jobs skipped.
3. Extracts the matching changelog section and contributors since the prior
   release tag.
4. Runs the complete stable QA gate (`release:check`) and the
   `VSCODE_TEST_VERSION=1.125.0` Extension Host acceptance suite. Packaging
   cannot start unless both succeed.
5. Builds and verifies all seven platform-specific VSIX packages, including
   the bundled native binary check.
6. Creates `vX.Y.Z` and a GitHub release titled `Release vX.Y.Z`, only after
   verification and every platform package succeed.
7. Marks versions with a SemVer prerelease suffix as prereleases.

Monitor the workflow:

```bash
gh run list --workflow release.yml
gh run watch
```

Marketplace publication still requires separate authorization and is not part
of this procedure.
