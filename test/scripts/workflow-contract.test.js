"use strict";

/**
 * Focused regression guard for the QA/release workflow contract. It checks
 * the invariants the approved change depends on -- the shared QA command
 * list, both acceptance versions, the aggregate gate and its failure
 * semantics, and release gating -- without pinning whole YAML files as
 * strings. It parses no YAML and adds no dependency; it asserts on the
 * specific lines that would regress if a required suite, an acceptance
 * version, an aggregate dependency, or a release gate were removed.
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..", "..");

function read(relativePath) {
  return fs
    .readFileSync(path.join(repoRoot, relativePath), "utf8")
    .replace(/\r\n/g, "\n");
}

const PACKAGE_TARGETS = [
  "win32-x64",
  "darwin-x64",
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "alpine-x64",
  "alpine-arm64",
];

const AGGREGATE_CONTEXT = "CI Required";
const MIN_VSCODE_VERSION = "1.125.0";

suite("workflow contract", () => {
  const runQa = read("test/scripts/run-qa.js");
  const pkg = JSON.parse(read("package.json"));
  const runTest = read("test/acceptance/runTest.ts");
  const ci = read(".github/workflows/ci.yml");
  const release = read(".github/workflows/release.yml");

  test("run-qa.js is the shared QA command list with every required suite", () => {
    for (const command of [
      "compile",
      "lint",
      "test:compile",
      "test:unit:run",
      "test:property:run",
      "test:release",
      "test:acceptance:run",
    ]) {
      assert.ok(
        runQa.includes(`"${command}"`),
        `run-qa.js must run ${command}`
      );
    }
  });

  test("local QA and release commands route through the shared list", () => {
    assert.strictEqual(pkg.scripts["test:qa"], "node test/scripts/run-qa.js");
    assert.strictEqual(pkg.scripts.test, "npm run test:qa");
    assert.ok(
      /\btest:qa\b/.test(pkg.scripts["release:check"]),
      "release:check must execute the shared QA gate (test:qa)"
    );
    assert.ok(
      !/test:unit\b/.test(pkg.scripts["release:check"]),
      "release:check must not restate an individual suite subset"
    );
  });

  test("release-metadata suite is part of the shared gate", () => {
    assert.strictEqual(
      pkg.scripts["test:release"],
      'mocha --ui tdd --timeout 20000 "test/scripts/*.test.js"'
    );
  });

  test("acceptance runner still defaults to stable", () => {
    assert.ok(
      /process\.env\.VSCODE_TEST_VERSION \|\| "stable"/.test(runTest),
      "runTest.ts must default VSCODE_TEST_VERSION to stable"
    );
  });

  suite("ci.yml", () => {
    test("runs the complete stable QA gate under a virtual display", () => {
      assert.ok(
        /xvfb-run -a npm run test:qa/.test(ci),
        "stable QA must run under xvfb-run"
      );
    });

    test("runs acceptance against exactly the minimum and stable versions", () => {
      assert.ok(
        ci.includes(`VSCODE_TEST_VERSION: "${MIN_VSCODE_VERSION}"`),
        "CI must run acceptance against the minimum supported VS Code"
      );
      assert.ok(
        /xvfb-run -a npm run test:acceptance/.test(ci),
        "minimum-version acceptance must run under xvfb-run"
      );
      const pinned = ci.match(/VSCODE_TEST_VERSION: "[^"]+"/g) || [];
      assert.deepStrictEqual(
        pinned,
        [`VSCODE_TEST_VERSION: "${MIN_VSCODE_VERSION}"`],
        "the only pinned acceptance version is the minimum; stable comes from the default"
      );
    });

    test("retains all seven platform package targets", () => {
      for (const target of PACKAGE_TARGETS) {
        assert.ok(
          new RegExp(`- ${target}\\n`).test(ci),
          `CI package matrix must keep ${target}`
        );
      }
    });

    test("exposes one uniquely named aggregate gate over every required area", () => {
      assert.ok(
        ci.includes(`name: ${AGGREGATE_CONTEXT}`),
        `aggregate job must be named "${AGGREGATE_CONTEXT}"`
      );
      const gate = ci.slice(ci.indexOf(`name: ${AGGREGATE_CONTEXT}`));
      for (const dependency of [
        "qa",
        "acceptance-min",
        "package-platform-targets",
      ]) {
        assert.ok(
          new RegExp(`- ${dependency}\\n`).test(gate),
          `aggregate gate must depend on ${dependency}`
        );
      }
      assert.ok(
        /if: \$\{\{ always\(\) \}\}/.test(gate),
        "aggregate gate must use always() so skips still evaluate it"
      );
      assert.ok(
        /!= "success"/.test(gate),
        "aggregate gate must fail unless each dependency reported success"
      );
    });

    test("aggregate context name is unique across workflows", () => {
      assert.ok(
        !/^\s*ci-required:/m.test(release),
        "aggregate job id must not also appear in release.yml"
      );
      assert.ok(
        !release.includes(`name: ${AGGREGATE_CONTEXT}`),
        "aggregate display name must not also appear in release.yml"
      );
    });
  });

  suite("release.yml", () => {
    test("runs the complete stable QA gate under a virtual display", () => {
      assert.ok(
        /xvfb-run -a npm run release:check/.test(release),
        "release verification must run the full QA gate under xvfb-run"
      );
    });

    test("runs minimum-version acceptance", () => {
      assert.ok(
        release.includes(`VSCODE_TEST_VERSION: "${MIN_VSCODE_VERSION}"`),
        "release must run acceptance against the minimum supported VS Code"
      );
      assert.ok(
        /verify-acceptance-min:/.test(release),
        "release must define the minimum-version acceptance job"
      );
    });

    test("packaging cannot start unless both verification paths succeed", () => {
      const pkgJob = section(release, "  package:", "  release:");
      assert.ok(/- verify\n/.test(pkgJob), "package needs verify");
      assert.ok(
        /- verify-acceptance-min\n/.test(pkgJob),
        "package needs verify-acceptance-min"
      );
    });

    test("release creation cannot start unless verification and packages succeed", () => {
      const releaseJob = release.slice(release.lastIndexOf("  release:"));
      for (const dependency of [
        "prepare",
        "verify",
        "verify-acceptance-min",
        "package",
      ]) {
        assert.ok(
          new RegExp(`- ${dependency}\\n`).test(releaseJob),
          `release must depend on ${dependency}`
        );
      }
    });

    test("an existing version stays a successful no-op", () => {
      const gated = (
        release.match(
          /if: needs\.prepare\.outputs\.should_release == 'true'/g
        ) || []
      ).length;
      assert.strictEqual(
        gated,
        4,
        "verify, verify-acceptance-min, package, and release must all gate on should_release"
      );
    });

    test("retains all seven platform package targets", () => {
      for (const target of PACKAGE_TARGETS) {
        assert.ok(
          new RegExp(`- ${target}\\n`).test(release),
          `release package matrix must keep ${target}`
        );
      }
    });

    test("retains the bundled native-binary check", () => {
      assert.ok(
        release.includes(
          "node_modules/sqlite3/build/Release/node_sqlite3.node"
        ),
        "release must still verify the bundled sqlite3 binary"
      );
    });
  });
});

function section(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  const end = text.indexOf(endMarker, start + startMarker.length);
  return text.slice(start, end === -1 ? undefined : end);
}
