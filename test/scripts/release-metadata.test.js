"use strict";

const assert = require("assert");
const {
  contributorsFromLog,
  extractChangelogSection,
  findPreviousTag,
  generateReleaseMetadata,
  parseSemver,
} = require("../../scripts/release-metadata");

suite("release metadata", () => {
  test("classifies stable and prerelease semantic versions", () => {
    assert.deepStrictEqual(parseSemver("1.0.0"), {
      version: "1.0.0",
      prerelease: false,
    });
    assert.strictEqual(parseSemver("1.0.1-rc-1").prerelease, true);
    assert.strictEqual(parseSemver("1.0.1-beta").prerelease, true);
  });

  test("rejects versions that are not strict semantic versions", () => {
    for (const version of ["v1.0.0", "1.0", "01.0.0", "1.0.0-01"]) {
      assert.throws(() => parseSemver(version), /Invalid semantic version/);
    }
  });

  test("extracts exactly the requested dated changelog section", () => {
    const changelog = `# Changelog

## [Unreleased]

Nothing yet.

## [1.0.1-beta] - 2026-08-01

### Added

- Beta work.

## [1.0.0] - 2026-07-26

### Added

- Stable work.
`;
    assert.strictEqual(
      extractChangelogSection(changelog, "1.0.1-beta"),
      "### Added\n\n- Beta work."
    );
    assert.strictEqual(
      extractChangelogSection(changelog, "1.0.0"),
      "### Added\n\n- Stable work."
    );
  });

  test("rejects missing and empty changelog sections", () => {
    assert.throws(
      () => extractChangelogSection("## [Unreleased]\n", "1.0.0"),
      /no dated section/
    );
    assert.throws(
      () =>
        extractChangelogSection(
          "## [1.0.0] - 2026-07-26\n\n## [0.1.0] - 2026-01-01\n",
          "1.0.0"
        ),
      /section for 1.0.0 is empty/
    );
  });

  test("deduplicates contributors, uses GitHub handles, and excludes bots", () => {
    const contributors = contributorsFromLog(
      [
        "Jorge Saldivar\t14043861+jsldvr@users.noreply.github.com",
        "Jorge Saldivar\tjsldvr@users.noreply.github.com",
        "Ada Lovelace\tada@example.com",
        "dependabot[bot]\t49699333+dependabot[bot]@users.noreply.github.com",
        "github-actions[bot]\tactions@github.com",
      ].join("\n")
    );
    assert.deepStrictEqual(contributors, ["@jsldvr", "Ada Lovelace"]);
  });

  test("selects the newest valid prior release tag", () => {
    const git = () => "not-a-release\nv1.0.1-beta\nv1.0.0\n";
    assert.strictEqual(findPreviousTag("v1.0.2", git), "v1.0.1-beta");
  });

  test("generates a title, tag, prerelease flag, changelog body, and contributors", () => {
    const metadata = generateReleaseMetadata({
      packageJson: { version: "1.0.1-rc-1" },
      changelog:
        "## [1.0.1-rc-1] - 2026-08-01\n\n### Fixed\n\n- A fix.\n",
      contributorLog:
        "Jorge Saldivar\t14043861+jsldvr@users.noreply.github.com\n",
      previousTag: "v1.0.0",
    });
    assert.strictEqual(metadata.tag, "v1.0.1-rc-1");
    assert.strictEqual(metadata.title, "Release v1.0.1-rc-1");
    assert.strictEqual(metadata.prerelease, true);
    assert.strictEqual(metadata.previousTag, "v1.0.0");
    assert.strictEqual(
      metadata.body,
      "### Fixed\n\n- A fix.\n\n## Contributors\n\n- @jsldvr\n"
    );
  });
});
