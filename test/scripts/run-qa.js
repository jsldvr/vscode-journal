"use strict";

const { spawnSync } = require("child_process");

const commands = [
  "compile",
  "lint",
  "test:compile",
  "test:unit:run",
  "test:property:run",
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
