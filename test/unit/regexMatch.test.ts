import * as assert from "assert";
import {
  InvalidSearchPatternError,
  SNIPPET_START,
  buildPatternSpec,
  compilePattern,
  makeMatchSnippet,
  runRegexSearch,
  truncatedHead,
} from "../../src/regexMatch";

function row(path: string, title: string, body: string) {
  return { path, title, body };
}

suite("regexMatch", () => {
  test("buildPatternSpec escapes literal text unless useRegex is set", () => {
    assert.deepStrictEqual(buildPatternSpec("a.b*c", {}), {
      source: "a\\.b\\*c",
      flags: "i",
    });
    assert.deepStrictEqual(buildPatternSpec("a.b*c", { useRegex: true }), {
      source: "a.b*c",
      flags: "i",
    });
  });

  test("buildPatternSpec applies matchCase and wholeWord", () => {
    assert.deepStrictEqual(buildPatternSpec("cat", { matchCase: true }), {
      source: "cat",
      flags: "",
    });
    assert.deepStrictEqual(
      buildPatternSpec("c.t", { useRegex: true, wholeWord: true }),
      { source: "\\b(?:c.t)\\b", flags: "i" }
    );
  });

  test("compilePattern normalizes a bad pattern to InvalidSearchPatternError", () => {
    assert.throws(
      () => compilePattern({ source: "(unclosed", flags: "" }),
      InvalidSearchPatternError
    );
    assert.ok(compilePattern({ source: "ok", flags: "i" }) instanceof RegExp);
  });

  test("runRegexSearch matches the body and highlights the snippet", () => {
    const hits = runRegexSearch({
      rows: [row("a.md", "Title", "order ord-123 here")],
      spec: buildPatternSpec("ord-\\d+", { useRegex: true }),
      limit: 100,
    });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].path, "a.md");
    assert.ok(hits[0].snippet.includes(`${SNIPPET_START}ord-123`));
  });

  test("runRegexSearch falls back to the title when the body does not match", () => {
    const hits = runRegexSearch({
      rows: [row("t.md", "Kumquat Chronicles", "nothing relevant in body")],
      spec: buildPatternSpec("kumquat", {}),
      limit: 100,
    });
    assert.strictEqual(hits.length, 1);
    // Title-only match: snippet is the truncated body head, no highlight.
    assert.ok(!hits[0].snippet.includes(SNIPPET_START));
  });

  test("runRegexSearch preserves input order and honours the limit", () => {
    const rows = [
      row("1.md", "", "match one"),
      row("2.md", "", "match two"),
      row("3.md", "", "match three"),
    ];
    const hits = runRegexSearch({
      rows,
      spec: buildPatternSpec("match", {}),
      limit: 2,
    });
    assert.deepStrictEqual(
      hits.map((hit) => hit.path),
      ["1.md", "2.md"]
    );
  });

  test("runRegexSearch supports lookarounds and backreferences", () => {
    const lookaround = runRegexSearch({
      rows: [row("l.md", "", "price is 42 dollars")],
      spec: buildPatternSpec("(?<=is )\\d+", { useRegex: true }),
      limit: 10,
    });
    assert.strictEqual(lookaround.length, 1);
    assert.ok(lookaround[0].snippet.includes(`${SNIPPET_START}42`));

    const backref = runRegexSearch({
      rows: [row("b.md", "", "hello hello world")],
      spec: buildPatternSpec("(\\w+) \\1", { useRegex: true }),
      limit: 10,
    });
    assert.strictEqual(backref.length, 1);
    assert.ok(backref[0].snippet.includes(`${SNIPPET_START}hello hello`));
  });

  test("runRegexSearch treats a zero-length match as no highlight", () => {
    const body = `${"x".repeat(80)} tail`;
    const hits = runRegexSearch({
      rows: [row("z.md", "", body)],
      spec: buildPatternSpec("a*", { useRegex: true }),
      limit: 10,
    });
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].snippet, truncatedHead(body));
    assert.ok(!hits[0].snippet.includes(SNIPPET_START));
  });

  test("runRegexSearch returns nothing when neither body nor title matches", () => {
    const hits = runRegexSearch({
      rows: [row("n.md", "Nope", "still nope")],
      spec: buildPatternSpec("absent", {}),
      limit: 10,
    });
    assert.deepStrictEqual(hits, []);
  });

  test("makeMatchSnippet re-exports the same helper", () => {
    const pattern = /needle/;
    const body = `${"x".repeat(100)} needle ${"y".repeat(100)}`;
    const snippet = makeMatchSnippet(body, pattern.exec(body));
    assert.ok(snippet.includes(`${SNIPPET_START}needle`));
    assert.ok(snippet.startsWith("..."));
    assert.ok(snippet.endsWith("..."));
  });
});
