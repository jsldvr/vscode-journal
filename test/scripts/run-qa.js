"use strict";

/**
 * Canonical QA contract for this repository. `npm run test:qa`, `npm test`,
 * and `npm run release:check` all execute this ordered list, and
 * `.github/workflows/ci.yml` / `.github/workflows/release.yml` invoke it
 * instead of restating the individual suites. Adding or removing an entry
 * changes what every local and CI gate enforces.
 *
 * Coverage: compile, lint, unit, property, release-metadata, and stable
 * Extension Host acceptance. Minimum-version acceptance
 * (`VSCODE_TEST_VERSION=1.125.0`) is run separately by the workflows.
 */
const { spawnSync } = require("child_process");

const commands = [
  "compile",
  "lint",
  "test:compile",
  "test:unit:run",
  "test:property:run",
  "test:release",
  "test:acceptance:run",
];

for (const script of commands) {
  const executable =
    process.platform === "win32" ? process.env.ComSpec || "cmd.exe" : "npm";
  const args =
    process.platform === "win32"
      ? ["/d", "/s", "/c", `npm run ${script}`]
      : ["run", script];
  const result = spawnSync(executable, args, {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status === null ? 1 : result.status);
  }
}
