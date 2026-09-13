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
//
// Release-asset delivery fails transiently often enough to break the
// required packaging matrix on a single HTTP 500, so every download is
// retried under a bounded policy. Retries are deliberately finite: a
// permanently missing asset must fail the build quickly rather than
// sleep through a retry budget.

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

const ASSET_HOST = "https://github.com/TryGhost/node-sqlite3/releases/download";

// Redirect budget for a single attempt. Each retry starts over with a
// full budget, so a redirect loop cannot consume the retry policy.
const MAX_REDIRECTS = 5;

// Total attempts, including the first. Delays between attempts are
// 1s, 2s, 4s (plus jitter), so the worst case adds roughly 7s before
// failing -- well inside the 15-minute packaging job timeout.
const MAX_ATTEMPTS = 4;
const BASE_RETRY_DELAY_MS = 1000;

// Upper bound for any single wait, applied to both exponential backoff
// and a server-supplied Retry-After, so an upstream header can never
// stall the job.
const MAX_RETRY_DELAY_MS = 8000;

// Jitter spreads concurrent matrix jobs that retry in lockstep. The
// delay stays within +/- this fraction of the computed backoff.
const RETRY_JITTER_RATIO = 0.25;

// Per-attempt socket inactivity timeout. A stalled connection is
// abandoned and retried rather than hanging the job.
const ATTEMPT_TIMEOUT_MS = 60000;

// Statuses worth another attempt: request timeout, rate limiting, and
// the 5xx family GitHub returns when asset delivery is degraded.
const TRANSIENT_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

// Socket-level failures that are demonstrably retryable. Permanent
// misconfiguration (for example ENOTFOUND) is excluded on purpose.
const TRANSIENT_NETWORK_CODES = new Set([
  "ECONNABORTED",
  "ECONNRESET",
  "EAI_AGAIN",
  "ENETRESET",
  "EPIPE",
  "ETIMEDOUT",
]);

function fail(message) {
  console.error(`stage-sqlite3-prebuild: ${message}`);
  process.exit(1);
}

function currentHostTarget() {
  const key = `${process.platform}-${process.arch}`;
  return TARGET_TO_PREBUILD[key] ? key : undefined;
}

function assetNameFor(version, prebuildPlatform) {
  return `sqlite3-v${version}-napi-v6-${prebuildPlatform}.tar.gz`;
}

function assetUrlFor(version, asset) {
  return `${ASSET_HOST}/v${version}/${asset}`;
}

function isTransientStatus(status) {
  return TRANSIENT_STATUSES.has(status);
}

function isTransientNetworkError(error) {
  if (!error) {
    return false;
  }
  if (error.transient === true) {
    return true;
  }
  return TRANSIENT_NETWORK_CODES.has(error.code);
}

/**
 * Marks an error as retryable or terminal. Classification travels with
 * the error so the retry loop never re-derives it from message text.
 */
function taggedError(message, transient, extra) {
  const error = new Error(message);
  error.transient = transient;
  Object.assign(error, extra || {});
  return error;
}

/**
 * Parses Retry-After, which is either delta-seconds or an HTTP date.
 * Returns undefined when the header is absent or unusable, and never
 * returns more than MAX_RETRY_DELAY_MS.
 */
function parseRetryAfterMs(headerValue, now) {
  if (typeof headerValue !== "string" || headerValue.trim() === "") {
    return undefined;
  }
  const raw = headerValue.trim();
  const reference = typeof now === "number" ? now : Date.now();

  if (/^\d+$/.test(raw)) {
    return Math.min(Number(raw) * 1000, MAX_RETRY_DELAY_MS);
  }

  const when = Date.parse(raw);
  if (Number.isNaN(when)) {
    return undefined;
  }
  const delta = when - reference;
  if (delta <= 0) {
    return 0;
  }
  return Math.min(delta, MAX_RETRY_DELAY_MS);
}

/**
 * Delay before the attempt after `completedAttempts`. A usable
 * Retry-After wins over exponential backoff; both are capped, and
 * jitter is applied only to the computed backoff.
 */
function retryDelayMs(completedAttempts, retryAfterMs, random) {
  if (typeof retryAfterMs === "number") {
    return Math.min(Math.max(retryAfterMs, 0), MAX_RETRY_DELAY_MS);
  }
  const exponential = BASE_RETRY_DELAY_MS * Math.pow(2, completedAttempts - 1);
  const capped = Math.min(exponential, MAX_RETRY_DELAY_MS);
  const roll = typeof random === "function" ? random() : Math.random();
  const jitter = capped * RETRY_JITTER_RATIO * (roll * 2 - 1);
  return Math.max(0, Math.round(capped + jitter));
}

function removeQuietly(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // A missing partial file is the expected state after a clean run.
  }
}

function contentLengthOf(headers) {
  const raw = headers && headers["content-length"];
  if (typeof raw !== "string" || !/^\d+$/.test(raw.trim())) {
    return undefined;
  }
  return Number(raw.trim());
}

/**
 * Runs one complete download attempt into `partialPath`, following up
 * to `maxRedirects` redirects. Calls `done` exactly once; every
 * competing request, response, timeout, and stream event is funnelled
 * through a single settle guard, and the partial file is removed
 * before any failure is reported.
 */
function downloadAttempt(url, partialPath, options, done) {
  const request = options.request || https.get;
  const timeoutMs = options.timeoutMs || ATTEMPT_TIMEOUT_MS;
  const maxRedirects =
    typeof options.maxRedirects === "number" ? options.maxRedirects : MAX_REDIRECTS;

  let settled = false;
  let out;
  let response;

  // Removing the partial file while the write stream still holds an
  // open handle fails on Windows, so cleanup waits for the stream to
  // close before unlinking.
  function settle(error) {
    if (settled) {
      return;
    }
    settled = true;
    if (response && !response.destroyed) {
      response.destroy();
    }
    if (!out || out.destroyed || out.closed) {
      conclude(error);
      return;
    }
    out.once("close", () => conclude(error));
    out.destroy();
  }

  function conclude(error) {
    if (error) {
      removeQuietly(partialPath);
      done(error);
      return;
    }
    done(null);
  }

  function finish(res, expectedBytes, receivedBytes) {
    if (typeof expectedBytes === "number" && receivedBytes !== expectedBytes) {
      settle(
        taggedError(
          `incomplete download for ${url}: expected ${expectedBytes} bytes, received ${receivedBytes}`,
          true
        )
      );
      return;
    }
    settle(null);
  }

  function consume(res, currentUrl) {
    const expectedBytes = contentLengthOf(res.headers);
    let receivedBytes = 0;

    response = res;
    out = fs.createWriteStream(partialPath);
    out.on("error", (error) => settle(taggedError(error.message, false, { code: error.code })));
    res.on("data", (chunk) => {
      receivedBytes += chunk.length;
    });
    res.on("error", (error) =>
      settle(taggedError(error.message, isTransientNetworkError(error), { code: error.code }))
    );
    res.on("aborted", () =>
      settle(taggedError(`response aborted for ${currentUrl}`, true))
    );
    out.on("close", () => finish(res, expectedBytes, receivedBytes));
    res.pipe(out);
  }

  function reject(res, currentUrl, status) {
    res.resume();
    const retryAfterMs = parseRetryAfterMs(res.headers && res.headers["retry-after"]);
    settle(
      taggedError(`HTTP ${status} for ${currentUrl}`, isTransientStatus(status), {
        status,
        retryAfterMs,
      })
    );
  }

  function issue(currentUrl, redirectsLeft) {
    const req = request(
      currentUrl,
      { headers: { "User-Agent": "vs-journal-build" }, timeout: timeoutMs },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (redirectsLeft === 0) {
            settle(taggedError(`too many redirects for ${url}`, false));
            return;
          }
          issue(res.headers.location, redirectsLeft - 1);
          return;
        }
        if (status !== 200) {
          reject(res, currentUrl, status);
          return;
        }
        consume(res, currentUrl);
      }
    );

    req.on("error", (error) =>
      settle(taggedError(error.message, isTransientNetworkError(error), { code: error.code }))
    );
    req.on("timeout", () => {
      req.destroy();
      settle(
        taggedError(`timed out after ${timeoutMs} ms for ${currentUrl}`, true, {
          code: "ETIMEDOUT",
        })
      );
    });
  }

  removeQuietly(partialPath);
  issue(url, maxRedirects);
}

function defaultSleep(ms, done) {
  setTimeout(done, ms);
}

/**
 * Downloads `url` to `destination` with bounded retries. The file at
 * `destination` is created only after a complete response has been
 * written, so a caller may treat its existence as proof of success.
 */
function downloadWithRetry(url, destination, options, done) {
  const settings = options || {};
  const maxAttempts = settings.maxAttempts || MAX_ATTEMPTS;
  const sleep = settings.sleep || defaultSleep;
  const partialPath = `${destination}.partial`;
  const log = settings.log || console.error;

  function attempt(attemptNumber) {
    downloadAttempt(url, partialPath, settings, (error) => {
      if (!error) {
        finalize();
        return;
      }
      if (!isTransientNetworkError(error) || attemptNumber >= maxAttempts) {
        removeQuietly(partialPath);
        done(finalError(error, attemptNumber));
        return;
      }
      const delay = retryDelayMs(attemptNumber, error.retryAfterMs, settings.random);
      log(
        `stage-sqlite3-prebuild: attempt ${attemptNumber}/${maxAttempts} failed (${error.message}); retrying in ${delay} ms`
      );
      sleep(delay, () => attempt(attemptNumber + 1));
    });
  }

  function finalize() {
    try {
      fs.renameSync(partialPath, destination);
    } catch (error) {
      removeQuietly(partialPath);
      done(taggedError(`could not finalize ${destination}: ${error.message}`, false));
      return;
    }
    done(null);
  }

  function finalError(error, attempts) {
    return taggedError(
      `${error.message} (after ${attempts} attempt${attempts === 1 ? "" : "s"})`,
      error.transient === true,
      { status: error.status, code: error.code, attempts }
    );
  }

  attempt(1);
}

function extractPrebuild(sqlite3Dir, asset) {
  // Relative paths with an explicit cwd keep GNU tar on Windows from
  // parsing the drive letter in C:\... as a remote host name.
  const extract = spawnSync("tar", ["-xzf", asset], {
    cwd: sqlite3Dir,
    stdio: "inherit",
  });
  removeQuietly(path.join(sqlite3Dir, asset));
  if (extract.status !== 0) {
    fail(`tar extraction failed with status ${extract.status}`);
  }
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
  const asset = assetNameFor(version, prebuildPlatform);
  const url = assetUrlFor(version, asset);
  const tarball = path.join(sqlite3Dir, asset);

  console.log(`Downloading ${url}`);
  downloadWithRetry(url, tarball, {}, (error) => {
    if (error) {
      fail(error.message);
      return;
    }
    extractPrebuild(sqlite3Dir, asset);
    const binary = path.join(sqlite3Dir, "build", "Release", "node_sqlite3.node");
    if (!fs.existsSync(binary)) {
      fail(`extraction did not produce ${binary}`);
    }
    const size = fs.statSync(binary).size;
    console.log(`Staged ${prebuildPlatform} binary for target ${target} (${size} bytes).`);
  });
}

if (require.main === module) {
  main();
}

module.exports = {
  ATTEMPT_TIMEOUT_MS,
  BASE_RETRY_DELAY_MS,
  MAX_ATTEMPTS,
  MAX_REDIRECTS,
  MAX_RETRY_DELAY_MS,
  TARGET_TO_PREBUILD,
  assetNameFor,
  assetUrlFor,
  downloadAttempt,
  downloadWithRetry,
  isTransientNetworkError,
  isTransientStatus,
  parseRetryAfterMs,
  retryDelayMs,
};
