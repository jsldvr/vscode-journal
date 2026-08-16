import * as assert from "assert";
import { validateMediaMessage } from "../../src/mediaWebviewSupport";

suite("mediaWebviewSupport", () => {
  test("valid inbound messages are accepted with their payloads", () => {
    assert.deepStrictEqual(validateMediaMessage({ type: "mediaRefresh" }), {
      type: "mediaRefresh",
    });
    assert.deepStrictEqual(validateMediaMessage({ type: "mediaUpload" }), {
      type: "mediaUpload",
    });
    assert.deepStrictEqual(
      validateMediaMessage({ type: "mediaOpen", path: "images/header.png" }),
      { type: "mediaOpen", path: "images/header.png" }
    );
    assert.deepStrictEqual(
      validateMediaMessage({ type: "mediaReveal", path: "clip.mp3" }),
      { type: "mediaReveal", path: "clip.mp3" }
    );
    assert.deepStrictEqual(
      validateMediaMessage({ type: "mediaCopyPath", path: "clip.mp3" }),
      { type: "mediaCopyPath", path: "clip.mp3" }
    );
    assert.deepStrictEqual(
      validateMediaMessage({ type: "mediaDelete", path: "clip.mp3" }),
      { type: "mediaDelete", path: "clip.mp3" }
    );
  });

  test("entry-vocabulary types are not accepted as media messages (disjoint namespaces)", () => {
    assert.strictEqual(validateMediaMessage({ type: "ready" }), undefined);
    assert.strictEqual(validateMediaMessage({ type: "refresh" }), undefined);
    assert.strictEqual(validateMediaMessage({ type: "upload" }), undefined);
    assert.strictEqual(
      validateMediaMessage({ type: "open", path: "2026/07/24/x.md" }),
      undefined
    );
  });

  test("structurally invalid messages are rejected", () => {
    assert.strictEqual(validateMediaMessage(null), undefined);
    assert.strictEqual(validateMediaMessage(undefined), undefined);
    assert.strictEqual(validateMediaMessage("mediaOpen"), undefined);
    assert.strictEqual(validateMediaMessage(42), undefined);
    assert.strictEqual(validateMediaMessage([]), undefined);
    assert.strictEqual(validateMediaMessage({}), undefined);
    assert.strictEqual(
      validateMediaMessage({ type: "unknown-type" }),
      undefined
    );
    assert.strictEqual(validateMediaMessage({ type: "mediaOpen" }), undefined);
    assert.strictEqual(
      validateMediaMessage({ type: "mediaDelete", path: 42 }),
      undefined
    );
    assert.strictEqual(
      validateMediaMessage({ type: "mediaReveal", path: null }),
      undefined
    );
    assert.strictEqual(
      validateMediaMessage({ type: "mediaCopyPath", path: { nested: true } }),
      undefined
    );
    assert.strictEqual(
      validateMediaMessage({ type: "mediaOpen", path: "" }),
      undefined
    );
  });

  test("oversized path strings are rejected", () => {
    assert.strictEqual(
      validateMediaMessage({ type: "mediaOpen", path: "a".repeat(4097) }),
      undefined
    );
    assert.deepStrictEqual(
      validateMediaMessage({ type: "mediaOpen", path: "a".repeat(4096) }),
      { type: "mediaOpen", path: "a".repeat(4096) }
    );
  });

  test("path-bearing types ignore extraneous payload fields safely", () => {
    assert.deepStrictEqual(
      validateMediaMessage({
        type: "mediaDelete",
        path: "clip.mp3",
        extra: "ignored",
      }),
      { type: "mediaDelete", path: "clip.mp3" }
    );
  });
});
