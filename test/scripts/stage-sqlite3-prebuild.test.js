"use strict";

/**
 * Regression guard for the sqlite3 prebuild downloader. A single
 * transient HTTP 500 from GitHub release assets once failed the whole
 * required packaging matrix, so these tests pin the retry policy,
 * failure classification, bounded delays, and partial-file handling.
 *
 * Every test injects its own HTTP transport, sleep, and jitter source.
 * Nothing here touches the public network or waits on a real timer.
 */
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { EventEmitter } = require("events");
const { Readable } = require("stream");

const downloader = require("../../scripts/stage-sqlite3-prebuild");

const {
  MAX_ATTEMPTS,
  MAX_REDIRECTS,
  MAX_RETRY_DELAY_MS,
  TARGET_TO_PREBUILD,
  assetNameFor,
  assetUrlFor,
  downloadAttempt,
  downloadWithRetry,
  extractPrebuild,
  isTransientNetworkError,
  isTransientStatus,
  parseRetryAfterMs,
  removeFile,
  retryDelayMs,
} = downloader;

function makeResponse(step) {
  const body = step.body === undefined ? "payload" : step.body;
  const res = new Readable({ read() {} });
  res.statusCode = step.status;
  res.headers = step.headers || {};
  process.nextTick(() => {
    if (step.status !== 200) {
      res.push(null);
      return;
    }
    res.push(Buffer.from(body));
    if (step.abort) {
      res.emit("aborted");
      return;
    }
    if (step.responseError) {
      res.emit("error", Object.assign(new Error("stream blew up"), { code: step.responseError }));
      return;
    }
    res.push(null);
  });
  return res;
}

/**
 * Builds a request function driven by an ordered script. Each entry
 * describes one HTTP call; the last entry repeats if the downloader
 * makes more calls than the script describes.
 */
function scriptedRequest(script) {
  const calls = [];
  function request(url, options, callback) {
    const step = script[Math.min(calls.length, script.length - 1)];
    calls.push({ url, options });
    const req = new EventEmitter();
    req.destroyed = false;
    req.destroy = function destroy() {
      req.destroyed = true;
    };
    process.nextTick(() => {
      if (step.networkError) {
        req.emit("error", Object.assign(new Error("socket failure"), { code: step.networkError }));
        return;
      }
      if (step.timeout) {
        req.emit("timeout");
        return;
      }
      callback(makeResponse(step));
    });
    return req;
  }
  request.calls = calls;
  return request;
}

const createdDirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sqlite3-prebuild-test-"));
  createdDirs.push(dir);
  return dir;
}

// Timers created by the trickling fixtures below. They are tracked here
// rather than per test so teardown can always stop them: if the
// downloader's deadline ever regresses its callback never fires, and a
// live interval would keep Node alive and hang the whole release suite
// instead of failing one test.
const activeIntervals = [];

function trackInterval(timer) {
  activeIntervals.push(timer);
  return timer;
}

function clearActiveIntervals() {
  while (activeIntervals.length > 0) {
    clearInterval(activeIntervals.pop());
  }
}

/** Best-effort teardown; a leaked directory must not fail the suite. */
function removeCreatedDirs() {
  while (createdDirs.length > 0) {
    const dir = createdDirs.pop();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // The OS temp directory is reclaimed eventually either way.
    }
  }
}

function recordingSleep(delays) {
  return function sleep(ms, done) {
    delays.push(ms);
    setImmediate(done);
  };
}

function baseOptions(request, delays) {
  return {
    request,
    sleep: recordingSleep(delays),
    random: () => 0.5, // centre of the jitter band -> zero jitter
    log: () => {},
    timeoutMs: 1234,
  };
}

suite("sqlite3 prebuild downloader", () => {
  // Every test mints its own temp directory; none may outlive the run.
  teardown(() => {
    clearActiveIntervals();
    removeCreatedDirs();
  });
  suiteTeardown(() => {
    clearActiveIntervals();
    removeCreatedDirs();
  });

  suite("asset contract", () => {
    test("the seven target mappings are unchanged", () => {
      assert.deepStrictEqual(TARGET_TO_PREBUILD, {
        "win32-x64": "win32-x64",
        "darwin-x64": "darwin-x64",
        "darwin-arm64": "darwin-arm64",
        "linux-x64": "linux-x64",
        "linux-arm64": "linux-arm64",
        "alpine-x64": "linuxmusl-x64",
        "alpine-arm64": "linuxmusl-arm64",
      });
    });

    test("generated asset names and URLs are unchanged for every target", () => {
      for (const [target, prebuild] of Object.entries(TARGET_TO_PREBUILD)) {
        const asset = assetNameFor("6.0.1", prebuild);
        assert.strictEqual(asset, `sqlite3-v6.0.1-napi-v6-${prebuild}.tar.gz`, target);
        assert.strictEqual(
          assetUrlFor("6.0.1", asset),
          `https://github.com/TryGhost/node-sqlite3/releases/download/v6.0.1/${asset}`,
          target
        );
      }
    });
  });

  suite("failure classification", () => {
    test("408, 429, 500, 502, 503 and 504 are transient", () => {
      for (const status of [408, 429, 500, 502, 503, 504]) {
        assert.strictEqual(isTransientStatus(status), true, `status ${status}`);
      }
    });

    test("permanent HTTP statuses are not transient", () => {
      for (const status of [400, 401, 403, 404, 410, 451]) {
        assert.strictEqual(isTransientStatus(status), false, `status ${status}`);
      }
    });

    test("ECONNRESET, ETIMEDOUT and EAI_AGAIN are transient network errors", () => {
      for (const code of ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"]) {
        assert.strictEqual(
          isTransientNetworkError(Object.assign(new Error("x"), { code })),
          true,
          code
        );
      }
    });

    test("a permanent network error is not retried", () => {
      assert.strictEqual(
        isTransientNetworkError(Object.assign(new Error("x"), { code: "ENOTFOUND" })),
        false
      );
      assert.strictEqual(isTransientNetworkError(undefined), false);
    });
  });

  suite("bounded delays", () => {
    test("backoff grows exponentially and stays capped", () => {
      const noJitter = () => 0.5;
      assert.strictEqual(retryDelayMs(1, undefined, noJitter), 1000);
      assert.strictEqual(retryDelayMs(2, undefined, noJitter), 2000);
      assert.strictEqual(retryDelayMs(3, undefined, noJitter), 4000);
      // Far beyond the policy, to prove the cap rather than the sequence.
      assert.strictEqual(retryDelayMs(20, undefined, noJitter), MAX_RETRY_DELAY_MS);
    });

    test("jitter stays within the documented band and never goes negative", () => {
      for (const roll of [0, 0.25, 0.5, 0.75, 1]) {
        const delay = retryDelayMs(3, undefined, () => roll);
        assert.ok(delay >= 3000 && delay <= 5000, `roll ${roll} gave ${delay}`);
      }
    });

    test("Retry-After seconds are honored and capped", () => {
      assert.strictEqual(parseRetryAfterMs("2"), 2000);
      assert.strictEqual(parseRetryAfterMs("99999"), MAX_RETRY_DELAY_MS);
      assert.strictEqual(retryDelayMs(1, 2000, () => 0.5), 2000);
      assert.strictEqual(retryDelayMs(1, 10 * 60 * 1000, () => 0.5), MAX_RETRY_DELAY_MS);
    });

    test("Retry-After HTTP dates are honored and capped", () => {
      const now = Date.UTC(2026, 0, 1, 0, 0, 0);
      const soon = new Date(now + 3000).toUTCString();
      assert.strictEqual(parseRetryAfterMs(soon, now), 3000);
      const distant = new Date(now + 60 * 60 * 1000).toUTCString();
      assert.strictEqual(parseRetryAfterMs(distant, now), MAX_RETRY_DELAY_MS);
      const past = new Date(now - 5000).toUTCString();
      assert.strictEqual(parseRetryAfterMs(past, now), 0);
    });

    test("an unusable Retry-After is ignored", () => {
      for (const value of [undefined, "", "   ", "not-a-date"]) {
        assert.strictEqual(parseRetryAfterMs(value), undefined, String(value));
      }
    });
  });

  suite("retry behavior", () => {
    test("a transient 500 followed by 200 succeeds and finalizes the file", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const delays = [];
      const request = scriptedRequest([
        { status: 500 },
        { status: 200, body: "real-bytes" },
      ]);

      downloadWithRetry("https://example.invalid/a.tar.gz", destination, baseOptions(request, delays), (error) => {
        assert.strictEqual(error, null);
        assert.strictEqual(request.calls.length, 2);
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "real-bytes");
        assert.strictEqual(fs.existsSync(`${destination}.partial`), false);
        assert.deepStrictEqual(delays, [1000]);
        done();
      });
    });

    test("each transient status is retried and can recover", (done) => {
      const statuses = [408, 429, 500, 502, 503, 504];
      let remaining = statuses.length;
      for (const status of statuses) {
        const dir = tempDir();
        const destination = path.join(dir, "asset.tar.gz");
        const request = scriptedRequest([{ status }, { status: 200, body: "ok" }]);
        downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
          assert.strictEqual(error, null, `status ${status}`);
          assert.strictEqual(request.calls.length, 2, `status ${status}`);
          remaining -= 1;
          if (remaining === 0) {
            done();
          }
        });
      }
    });

    test("transient network errors are retried and can recover", (done) => {
      const codes = ["ECONNRESET", "ETIMEDOUT", "EAI_AGAIN"];
      let remaining = codes.length;
      for (const code of codes) {
        const dir = tempDir();
        const destination = path.join(dir, "asset.tar.gz");
        const request = scriptedRequest([{ networkError: code }, { status: 200, body: "ok" }]);
        downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
          assert.strictEqual(error, null, code);
          assert.strictEqual(request.calls.length, 2, code);
          assert.strictEqual(fs.readFileSync(destination, "utf8"), "ok", code);
          remaining -= 1;
          if (remaining === 0) {
            done();
          }
        });
      }
    });

    test("an attempt timeout is retried and every attempt carries a finite timeout", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const request = scriptedRequest([{ timeout: true }, { status: 200, body: "ok" }]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
        assert.strictEqual(error, null);
        assert.strictEqual(request.calls.length, 2);
        for (const call of request.calls) {
          assert.strictEqual(call.options.timeout, 1234);
        }
        done();
      });
    });

    test("retries stop at the attempt limit and report the final cause", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const delays = [];
      const request = scriptedRequest([{ status: 503 }]);

      downloadWithRetry("https://example.invalid/a.tar.gz", destination, baseOptions(request, delays), (error) => {
        assert.ok(error, "expected a final error");
        assert.strictEqual(request.calls.length, MAX_ATTEMPTS);
        assert.match(error.message, /HTTP 503/);
        assert.match(error.message, new RegExp(`after ${MAX_ATTEMPTS} attempts`));
        assert.strictEqual(error.attempts, MAX_ATTEMPTS);
        assert.strictEqual(fs.existsSync(destination), false);
        assert.strictEqual(fs.existsSync(`${destination}.partial`), false);
        assert.deepStrictEqual(delays, [1000, 2000, 4000]);
        done();
      });
    });

    test("permanent HTTP failures fail after exactly one attempt without sleeping", (done) => {
      const statuses = [401, 403, 404];
      let remaining = statuses.length;
      for (const status of statuses) {
        const dir = tempDir();
        const destination = path.join(dir, "asset.tar.gz");
        const delays = [];
        const request = scriptedRequest([{ status }]);
        downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, delays), (error) => {
          assert.ok(error, `status ${status}`);
          assert.strictEqual(request.calls.length, 1, `status ${status}`);
          assert.deepStrictEqual(delays, [], `status ${status} must not sleep`);
          assert.match(error.message, new RegExp(`HTTP ${status}`));
          assert.match(error.message, /after 1 attempt\b/);
          assert.strictEqual(fs.existsSync(destination), false);
          remaining -= 1;
          if (remaining === 0) {
            done();
          }
        });
      }
    });

    test("a 429 carrying Retry-After waits exactly that long, capped", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const delays = [];
      const request = scriptedRequest([
        { status: 429, headers: { "retry-after": "3" } },
        { status: 200, body: "ok" },
      ]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, delays), (error) => {
        assert.strictEqual(error, null);
        assert.deepStrictEqual(delays, [3000]);
        done();
      });
    });

    test("an oversized Retry-After cannot stall the job", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const delays = [];
      const request = scriptedRequest([
        { status: 503, headers: { "retry-after": "86400" } },
        { status: 200, body: "ok" },
      ]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, delays), (error) => {
        assert.strictEqual(error, null);
        assert.deepStrictEqual(delays, [MAX_RETRY_DELAY_MS]);
        done();
      });
    });
  });

  suite("response integrity", () => {
    test("a truncated body with a valid Content-Length is rejected", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const request = scriptedRequest([
        { status: 200, headers: { "content-length": "100" }, body: "short" },
      ]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
        assert.ok(error, "truncated response must fail");
        assert.match(error.message, /incomplete download/);
        assert.match(error.message, /expected 100 bytes, received 5/);
        assert.strictEqual(fs.existsSync(destination), false, "must not finalize a truncated file");
        assert.strictEqual(fs.existsSync(`${destination}.partial`), false);
        done();
      });
    });

    test("a truncated body is transient, so it retries and can recover", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const request = scriptedRequest([
        { status: 200, headers: { "content-length": "100" }, body: "short" },
        { status: 200, body: "complete" },
      ]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
        assert.strictEqual(error, null);
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "complete");
        done();
      });
    });

    test("a matching Content-Length is accepted", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const request = scriptedRequest([
        { status: 200, headers: { "content-length": "8" }, body: "complete" },
      ]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
        assert.strictEqual(error, null);
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "complete");
        done();
      });
    });

    test("an aborted response is rejected and leaves no partial file", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const request = scriptedRequest([{ status: 200, abort: true, body: "half" }]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
        assert.ok(error, "aborted response must fail");
        assert.match(error.message, /aborted/);
        assert.strictEqual(fs.existsSync(destination), false);
        assert.strictEqual(fs.existsSync(`${destination}.partial`), false);
        done();
      });
    });
  });

  suite("redirects", () => {
    test("redirects are followed within the budget", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const request = scriptedRequest([
        { status: 302, headers: { location: "https://cdn.invalid/a" } },
        { status: 200, body: "redirected" },
      ]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
        assert.strictEqual(error, null);
        assert.strictEqual(request.calls[1].url, "https://cdn.invalid/a");
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "redirected");
        done();
      });
    });

    test("exceeding the redirect budget fails without consuming retries", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const delays = [];
      // Always redirects, so the attempt can only end by exhausting the budget.
      const request = scriptedRequest([
        { status: 302, headers: { location: "https://cdn.invalid/loop" } },
      ]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, delays), (error) => {
        assert.ok(error, "redirect exhaustion must fail");
        assert.match(error.message, /too many redirects/);
        assert.deepStrictEqual(delays, [], "redirect exhaustion is permanent, not retried");
        assert.strictEqual(request.calls.length, MAX_REDIRECTS + 1);
        assert.strictEqual(fs.existsSync(destination), false);
        done();
      });
    });

    test("a redirect response is closed and cannot keep streaming", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      let redirectRes;
      let redirectReq;
      let observed;
      let pushesAfterRedirect = 0;
      let call = 0;

      // The 302 body never ends. Resuming it is not enough: only
      // destroying it releases the handle before the attempt deadline.
      function request(url, options, callback) {
        call += 1;
        const req = new EventEmitter();
        req.destroyed = false;
        req.destroy = function destroy() {
          req.destroyed = true;
        };
        const isRedirect = call === 1;
        if (isRedirect) {
          redirectReq = req;
        }
        process.nextTick(() => {
          const res = new Readable({ read() {} });
          res.on("error", () => {});
          if (isRedirect) {
            res.statusCode = 302;
            res.headers = { location: "https://cdn.invalid/a" };
            redirectRes = res;
            callback(res);
            trackInterval(
              setInterval(() => {
                if (!res.destroyed) {
                  pushesAfterRedirect += 1;
                  res.push(Buffer.from("x"));
                }
              }, 5)
            );
            return;
          }
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          // Hold the attempt open so the abandoned hop can be observed
          // mid-attempt. Checking after settlement proves nothing:
          // settlement tears every tracked stream down anyway.
          setTimeout(() => {
            const pushesBefore = pushesAfterRedirect;
            setTimeout(() => {
              observed = {
                destroyed: redirectRes.destroyed,
                stillStreaming: pushesAfterRedirect > pushesBefore,
              };
              res.push(Buffer.from("ok"));
              res.push(null);
            }, 30);
          }, 10);
        });
        return req;
      }

      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
        assert.strictEqual(error, null);
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "ok");
        assert.ok(observed, "the in-flight observation never ran");
        assert.strictEqual(
          observed.destroyed,
          true,
          "the redirect response must be destroyed while the attempt is still running"
        );
        assert.strictEqual(
          observed.stillStreaming,
          false,
          "the abandoned redirect response was still receiving bytes mid-attempt"
        );
        assert.strictEqual(redirectReq.destroyed, true, "the redirect request must be destroyed");
        done();
      });
    });

    test("each attempt gets its own redirect budget", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      // One redirect, then a transient 500; the retry redirects again,
      // proving the budget resets rather than carrying over.
      const request = scriptedRequest([
        { status: 302, headers: { location: "https://cdn.invalid/a" } },
        { status: 500 },
        { status: 302, headers: { location: "https://cdn.invalid/a" } },
        { status: 200, body: "ok" },
      ]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
        assert.strictEqual(error, null);
        assert.strictEqual(request.calls.length, 4);
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "ok");
        done();
      });
    });
  });

  suite("single settlement", () => {
    test("competing timeout, request and response errors settle an attempt once", (done) => {
      const dir = tempDir();
      const partial = path.join(dir, "asset.tar.gz.partial");
      let settlements = 0;

      function stormyRequest(url, options, callback) {
        const req = new EventEmitter();
        req.destroy = function destroy() {
          req.destroyed = true;
        };
        process.nextTick(() => {
          const res = new Readable({ read() {} });
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          // Everything that could settle the attempt, at once.
          res.push(Buffer.from("partial"));
          res.emit("aborted");
          res.emit("error", Object.assign(new Error("boom"), { code: "ECONNRESET" }));
          req.emit("timeout");
          req.emit("error", Object.assign(new Error("late"), { code: "ECONNRESET" }));
        });
        return req;
      }

      downloadAttempt("https://example.invalid/a", partial, { request: stormyRequest }, () => {
        settlements += 1;
      });

      setTimeout(() => {
        assert.strictEqual(settlements, 1, "attempt settled more than once");
        assert.strictEqual(fs.existsSync(partial), false, "partial file must be removed");
        done();
      }, 60);
    });

    test("a late error after success cannot re-settle or delete the download", (done) => {
      const dir = tempDir();
      const partial = path.join(dir, "asset.tar.gz.partial");
      let settlements = 0;
      let lateRes;

      function lateErrorRequest(url, options, callback) {
        const req = new EventEmitter();
        req.destroy = function destroy() {};
        process.nextTick(() => {
          const res = new Readable({ read() {} });
          res.statusCode = 200;
          res.headers = {};
          lateRes = res;
          callback(res);
          res.push(Buffer.from("complete"));
          res.push(null);
        });
        return req;
      }

      downloadAttempt("https://example.invalid/a", partial, { request: lateErrorRequest }, (error) => {
        settlements += 1;
        assert.strictEqual(error, null);
        // Fire a late failure after the attempt already succeeded.
        lateRes.emit("error", Object.assign(new Error("too late"), { code: "ECONNRESET" }));
      });

      setTimeout(() => {
        assert.strictEqual(settlements, 1);
        assert.strictEqual(fs.readFileSync(partial, "utf8"), "complete");
        done();
      }, 60);
    });
  });

  suite("absolute attempt deadline", () => {
    // A socket inactivity timeout cannot bound these: traffic keeps
    // arriving, or a hop never responds, so only a wall-clock deadline
    // ends the attempt.
    let lastTrickleResponse;

    function tricklingRequest() {
      return function request(url, options, callback) {
        const req = new EventEmitter();
        req.destroyed = false;
        req.destroy = function destroy() {
          req.destroyed = true;
        };
        process.nextTick(() => {
          const res = new Readable({ read() {} });
          res.statusCode = 200;
          res.headers = {};
          res.on("error", () => {});
          lastTrickleResponse = res;
          callback(res);
          // Registered globally so teardown stops it even when the
          // downloader never settles.
          trackInterval(
            setInterval(() => {
              if (!res.destroyed) {
                res.push(Buffer.from("x"));
              }
            }, 5)
          );
        });
        return req;
      };
    }

    test("a response that never completes is abandoned at the deadline", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const options = baseOptions(tricklingRequest(), []);
      options.deadlineMs = 60;
      options.maxAttempts = 1;

      downloadWithRetry("https://example.invalid/a", destination, options, (error) => {
        assert.ok(error, "a trickling response must not run forever");
        assert.match(error.message, /exceeded its 60 ms deadline/);
        assert.strictEqual(fs.existsSync(destination), false);
        assert.strictEqual(fs.existsSync(`${destination}.partial`), false);
        // Settlement must also release the stream it was reading, or
        // the handle outlives the attempt it was supposed to bound.
        assert.strictEqual(
          lastTrickleResponse.destroyed,
          true,
          "settlement must destroy the response it abandoned"
        );
        done();
      });
    });

    test("a request that never responds is abandoned at the deadline", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      function silentRequest() {
        const req = new EventEmitter();
        req.destroyed = false;
        req.destroy = function destroy() {
          req.destroyed = true;
        };
        return req; // never calls back, never errors
      }
      const options = baseOptions(silentRequest, []);
      options.deadlineMs = 50;
      options.maxAttempts = 1;

      downloadWithRetry("https://example.invalid/a", destination, options, (error) => {
        assert.ok(error, "a silent request must not hang the attempt");
        assert.match(error.message, /exceeded its 50 ms deadline/);
        done();
      });
    });

    test("the deadline is transient, so a later attempt can still succeed", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const trickle = tricklingRequest();
      let call = 0;

      function request(url, options, callback) {
        call += 1;
        if (call === 1) {
          return trickle(url, options, callback);
        }
        const req = new EventEmitter();
        req.destroy = function destroy() {};
        process.nextTick(() => {
          const res = new Readable({ read() {} });
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          res.push(Buffer.from("recovered"));
          res.push(null);
        });
        return req;
      }

      const options = baseOptions(request, []);
      options.deadlineMs = 60;

      downloadWithRetry("https://example.invalid/a", destination, options, (error) => {
        assert.strictEqual(error, null);
        assert.strictEqual(call, 2);
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "recovered");
        done();
      });
    });
  });

  suite("cleanup failures are not silent", () => {
    test("removeFile ignores a missing file but reports other failures", () => {
      const dir = tempDir();
      assert.doesNotThrow(() => removeFile(path.join(dir, "never-existed")));
      // A directory cannot be unlinked, which stands in for EPERM/EACCES.
      const blocked = path.join(dir, "blocked");
      fs.mkdirSync(blocked);
      assert.throws(() => removeFile(blocked));
    });

    test("a partial path that cannot be cleared fails without retrying", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      fs.mkdirSync(`${destination}.partial`);
      const delays = [];
      const request = scriptedRequest([{ status: 200, body: "ok" }]);

      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, delays), (error) => {
        assert.ok(error, "an unclearable partial path must fail");
        assert.match(error.message, /could not clear the partial file/);
        assert.deepStrictEqual(delays, [], "a cleanup failure must not be retried");
        assert.strictEqual(request.calls.length, 0, "no request should be issued");
        assert.strictEqual(fs.existsSync(destination), false);
        done();
      });
    });

    test("a finalization failure also reports a partial that could not be removed", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const request = scriptedRequest([{ status: 200, body: "ok" }]);
      const options = baseOptions(request, []);
      options.rename = () => {
        throw Object.assign(new Error("rename blocked"), { code: "EPERM" });
      };
      options.removePartial = () =>
        Object.assign(new Error("unlink blocked"), { code: "EBUSY" });

      downloadWithRetry("https://example.invalid/a", destination, options, (error) => {
        assert.ok(error, "a failed rename must fail the download");
        assert.match(error.message, /could not finalize/);
        assert.match(error.message, /rename blocked/);
        // Both failures must survive, not just the first.
        assert.match(error.message, /could not be removed/);
        assert.match(error.message, /unlink blocked/);
        done();
      });
    });

    test("a finalization failure alone does not invent a cleanup failure", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const request = scriptedRequest([{ status: 200, body: "ok" }]);
      const options = baseOptions(request, []);
      options.rename = () => {
        throw Object.assign(new Error("rename blocked"), { code: "EPERM" });
      };

      downloadWithRetry("https://example.invalid/a", destination, options, (error) => {
        assert.ok(error);
        assert.match(error.message, /could not finalize/);
        assert.doesNotMatch(error.message, /could not be removed/);
        done();
      });
    });

    test("a failed extraction also reports an archive that could not be removed", () => {
      const message = extractPrebuild("/tmp/nowhere", "asset.tar.gz", {
        spawn: () => ({ status: 2 }),
        remove: () => {
          throw Object.assign(new Error("archive locked"), { code: "EBUSY" });
        },
      });
      assert.match(String(message), /tar extraction failed with status 2/);
      // Extraction failing does not excuse leaving the archive behind.
      assert.match(String(message), /the downloaded archive asset\.tar\.gz could not be removed/);
      assert.match(String(message), /archive locked/);
    });

    test("a failed extraction is reported", () => {
      const message = extractPrebuild("/tmp/nowhere", "asset.tar.gz", {
        spawn: () => ({ status: 2 }),
        remove: () => {},
      });
      assert.match(String(message), /tar extraction failed with status 2/);
    });

    test("a downloaded archive that cannot be removed fails the staging step", () => {
      // .vscodeignore does not exclude *.tar.gz, so a surviving archive
      // would otherwise be packaged into the VSIX.
      const message = extractPrebuild("/tmp/nowhere", "asset.tar.gz", {
        spawn: () => ({ status: 0 }),
        remove: () => {
          throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        },
      });
      assert.match(String(message), /could not remove the downloaded archive asset\.tar\.gz/);
      assert.match(String(message), /permission denied/);
    });

    test("a clean extraction reports no error", () => {
      let removed;
      const message = extractPrebuild("/tmp/nowhere", "asset.tar.gz", {
        spawn: () => ({ status: 0 }),
        remove: (target) => {
          removed = target;
        },
      });
      assert.strictEqual(message, undefined);
      assert.match(String(removed), /asset\.tar\.gz$/);
    });
  });

  suite("finalization", () => {
    test("the destination appears only after a complete response", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const seen = [];
      const request = scriptedRequest([{ status: 500 }, { status: 200, body: "ok" }]);
      const options = baseOptions(request, []);
      options.sleep = function sleep(ms, next) {
        // Between attempts nothing may be finalized yet.
        seen.push({
          destination: fs.existsSync(destination),
          partial: fs.existsSync(`${destination}.partial`),
        });
        setImmediate(next);
      };

      downloadWithRetry("https://example.invalid/a", destination, options, (error) => {
        assert.strictEqual(error, null);
        assert.deepStrictEqual(seen, [{ destination: false, partial: false }]);
        assert.strictEqual(fs.existsSync(destination), true);
        done();
      });
    });

    test("a half-written body is never visible at the destination path", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      const midFlight = [];

      // Extraction keys off the destination path, so a partially
      // written archive must never appear there -- not even briefly.
      function slowRequest(url, options, callback) {
        const req = new EventEmitter();
        req.destroy = function destroy() {};
        process.nextTick(() => {
          const res = new Readable({ read() {} });
          res.statusCode = 200;
          res.headers = {};
          callback(res);
          res.push(Buffer.from("first-half"));
          setTimeout(() => {
            midFlight.push({
              destination: fs.existsSync(destination),
              partial: fs.existsSync(`${destination}.partial`),
            });
            res.push(Buffer.from("second-half"));
            res.push(null);
          }, 20);
        });
        return req;
      }

      const options = baseOptions(slowRequest, []);
      options.request = slowRequest;
      downloadWithRetry("https://example.invalid/a", destination, options, (error) => {
        assert.strictEqual(error, null);
        assert.deepStrictEqual(
          midFlight,
          [{ destination: false, partial: true }],
          "in-flight bytes must land in the partial file, not the destination"
        );
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "first-halfsecond-half");
        done();
      });
    });

    test("a stale partial file from an earlier crash is discarded", (done) => {
      const dir = tempDir();
      const destination = path.join(dir, "asset.tar.gz");
      fs.writeFileSync(`${destination}.partial`, "garbage from a previous run");
      const request = scriptedRequest([{ status: 200, body: "fresh" }]);
      downloadWithRetry("https://example.invalid/a", destination, baseOptions(request, []), (error) => {
        assert.strictEqual(error, null);
        assert.strictEqual(fs.readFileSync(destination, "utf8"), "fresh");
        done();
      });
    });
  });
});
