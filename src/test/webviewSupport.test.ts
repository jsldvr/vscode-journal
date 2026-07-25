import * as assert from "assert";
import { escapeHtml, validateWebviewMessage } from "../webviewSupport";

suite("webviewSupport", () => {
  test("valid inbound messages are accepted with their payloads", () => {
    assert.deepStrictEqual(validateWebviewMessage({ type: "ready" }), {
      type: "ready",
    });
    assert.deepStrictEqual(validateWebviewMessage({ type: "clear" }), {
      type: "clear",
    });
    assert.deepStrictEqual(
      validateWebviewMessage({ type: "search", query: "hello" }),
      { type: "search", query: "hello" }
    );
    assert.deepStrictEqual(
      validateWebviewMessage({ type: "open", path: "2026/07/24/x.md" }),
      { type: "open", path: "2026/07/24/x.md" }
    );
    assert.deepStrictEqual(validateWebviewMessage({ type: "tag", tag: "a" }), {
      type: "tag",
      tag: "a",
    });
    assert.deepStrictEqual(validateWebviewMessage({ type: "newEntry" }), {
      type: "newEntry",
    });
    assert.deepStrictEqual(
      validateWebviewMessage({
        type: "search",
        query: "hello",
        matchCase: true,
        wholeWord: false,
        useRegex: true,
      }),
      {
        type: "search",
        query: "hello",
        matchCase: true,
        wholeWord: false,
        useRegex: true,
      }
    );
  });

  test("search messages with invalid toggle types are rejected", () => {
    assert.strictEqual(
      validateWebviewMessage({ type: "search", query: "x", matchCase: "yes" }),
      undefined
    );
    assert.strictEqual(
      validateWebviewMessage({ type: "search", query: "x", wholeWord: 1 }),
      undefined
    );
    assert.strictEqual(
      validateWebviewMessage({ type: "search", query: "x", useRegex: null }),
      undefined
    );
  });

  test("structurally invalid messages are rejected", () => {
    assert.strictEqual(validateWebviewMessage(null), undefined);
    assert.strictEqual(validateWebviewMessage("search"), undefined);
    assert.strictEqual(validateWebviewMessage(42), undefined);
    assert.strictEqual(validateWebviewMessage({}), undefined);
    assert.strictEqual(
      validateWebviewMessage({ type: "unknown-type" }),
      undefined
    );
    assert.strictEqual(validateWebviewMessage({ type: "search" }), undefined);
    assert.strictEqual(
      validateWebviewMessage({ type: "search", query: 42 }),
      undefined
    );
    assert.strictEqual(
      validateWebviewMessage({ type: "open", path: { nested: true } }),
      undefined
    );
    assert.strictEqual(
      validateWebviewMessage({ type: "search", query: "x".repeat(2001) }),
      undefined
    );
  });

  test("escapeHtml escapes every HTML-significant character", () => {
    assert.strictEqual(
      escapeHtml(`<script>alert("x&y")</script>'`),
      "&lt;script&gt;alert(&quot;x&amp;y&quot;)&lt;/script&gt;&#39;"
    );
    assert.strictEqual(escapeHtml("plain text"), "plain text");
  });
});
