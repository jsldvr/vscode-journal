#!/usr/bin/env node
"use strict";

// Stages the sqlite3 N-API prebuilt binary for a vsce packaging target.
//
//   node scripts/stage-sqlite3-prebuild.js <vsce-target>
//
// Downloads the matching napi-v6 prebuild from the sqlite3 GitHub
// release for the exact pinned version and extracts it over
// node_modules/sqlite3/build/Release/, so a subsequent
// `vsce package --target <vsce-target>` bundles the right binary.
// With no argument it stages the binary for the current host.
//
// N-API binaries are ABI-stable across Node and Electron versions, so
// one binary per platform covers every VS Code version the extension
// supports. Targets absent from the sqlite3 release assets (for
// example win32-arm64) cannot be packaged and are rejected here.

const fs = require("fs");
const https = require("https");
const path = require("path");
const { spawnSync } = require("child_process");

const TARGET_TO_PREBUILD = {
  "win32-x64": "win32-x64",
  "darwin-x64": "darwin-x64",
  "darwin-arm64": "darwin-arm64",
  "linux-x64": "linux-x64",
  "linux-arm64": "linux-arm64",
  "alpine-x64": "linuxmusl-x64",
  "alpine-arm64": "linuxmusl-arm64",
};

const MAX_REDIRECTS = 5;

function fail(message) {
  console.error(`stage-sqlite3-prebuild: ${message}`);
  process.exit(1);
}

function currentHostTarget() {
  const key = `${process.platform}-${process.arch}`;
  return TARGET_TO_PREBUILD[key] ? key : undefined;
}

function download(url, destination, redirectsLeft, done) {
  https
    .get(url, { headers: { "User-Agent": "vs-journal-build" } }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft === 0) {
          done(new Error("too many redirects"));
          return;
        }
        download(res.headers.location, destination, redirectsLeft - 1, done);
        return;
      }
      if (status !== 200) {
        res.resume();
        done(new Error(`HTTP ${status} for ${url}`));
        return;
      }
      const out = fs.createWriteStream(destination);
      res.pipe(out);
      out.on("finish", () => out.close(() => done(null)));
      out.on("error", (error) => done(error));
    })
    .on("error", (error) => done(error));
}

function main() {
  const target = process.argv[2] || currentHostTarget();
  if (!target) {
    fail(`no prebuild exists for this host (${process.platform}-${process.arch})`);
  }
  const prebuildPlatform = TARGET_TO_PREBUILD[target];
  if (!prebuildPlatform) {
    fail(
      `unsupported vsce target "${target}". Supported: ${Object.keys(TARGET_TO_PREBUILD).join(", ")}`
    );
  }

  const sqlite3Dir = path.join(__dirname, "..", "node_modules", "sqlite3");
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(sqlite3Dir, "package.json"), "utf8")
  );
  const version = packageJson.version;
  const asset = `sqlite3-v${version}-napi-v6-${prebuildPlatform}.tar.gz`;
  const url = `https://github.com/TryGhost/node-sqlite3/releases/download/v${version}/${asset}`;
  const tarball = path.join(sqlite3Dir, asset);

  console.log(`Downloading ${url}`);
  download(url, tarball, MAX_REDIRECTS, (error) => {
    if (error) {
      fail(error.message);
    }
    // Relative paths with an explicit cwd keep GNU tar on Windows from
    // parsing the drive letter in C:\... as a remote host name.
    const extract = spawnSync("tar", ["-xzf", asset], {
      cwd: sqlite3Dir,
      stdio: "inherit",
    });
    fs.unlinkSync(tarball);
    if (extract.status !== 0) {
      fail(`tar extraction failed with status ${extract.status}`);
    }
    const binary = path.join(sqlite3Dir, "build", "Release", "node_sqlite3.node");
    if (!fs.existsSync(binary)) {
      fail(`extraction did not produce ${binary}`);
    }
    const size = fs.statSync(binary).size;
    console.log(`Staged ${prebuildPlatform} binary for target ${target} (${size} bytes).`);
  });
}

main();
