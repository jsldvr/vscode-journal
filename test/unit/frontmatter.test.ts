import * as assert from "assert";
import { parseEntryContent } from "../../src/frontmatter";

const SAMPLE = `---
title: Hello World
date: 2026-07-24 10:00:00
tags: [alpha, beta]
---

# Hello World

Body content here.
`;

suite("frontmatter", () => {
  test("parses title, date, and inline tag arrays", () => {
    const parsed = parseEntryContent(SAMPLE);
    assert.strictEqual(parsed.title, "Hello World");
    assert.strictEqual(parsed.date, "2026-07-24 10:00:00");
    assert.deepStrictEqual(parsed.tags, ["alpha", "beta"]);
  });

  test("body excludes the frontmatter block entirely", () => {
    const parsed = parseEntryContent(SAMPLE);
    assert.ok(!parsed.body.includes("title:"));
    assert.ok(!parsed.body.includes("tags:"));
    assert.ok(!parsed.body.includes("---"));
    assert.ok(parsed.body.includes("# Hello World"));
    assert.ok(parsed.body.includes("Body content here."));
  });

  test("CRLF files parse without leaking carriage returns", () => {
    const crlf = SAMPLE.replace(/\n/g, "\r\n");
    const parsed = parseEntryContent(crlf);
    assert.strictEqual(parsed.title, "Hello World");
    assert.deepStrictEqual(parsed.tags, ["alpha", "beta"]);
    assert.ok(!parsed.body.includes("\r"));
  });

  test("content without frontmatter is all body with no metadata", () => {
    const parsed = parseEntryContent("# Just a heading\n\nText.\n");
    assert.strictEqual(parsed.title, undefined);
    assert.strictEqual(parsed.date, undefined);
    assert.deepStrictEqual(parsed.tags, []);
    assert.ok(parsed.body.startsWith("# Just a heading"));
  });

  test("quoted values and single tags are unquoted", () => {
    const content = `---
title: "Quoted Title"
date: '2026-01-01 00:00:00'
tags: solo
---

Body.
`;
    const parsed = parseEntryContent(content);
    assert.strictEqual(parsed.title, "Quoted Title");
    assert.strictEqual(parsed.date, "2026-01-01 00:00:00");
    assert.deepStrictEqual(parsed.tags, ["solo"]);
  });
});
