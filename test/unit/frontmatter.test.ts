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

const PUB_DATE_SAMPLE = `---
title: Astro Post
pubDate: 2026-03-15 08:30:00
tags: [astro]
---

# Astro Post

Astro body content.
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

  test("Astro-style pubDate is parsed when date is absent", () => {
    const parsed = parseEntryContent(PUB_DATE_SAMPLE);
    assert.strictEqual(parsed.title, "Astro Post");
    assert.strictEqual(parsed.pubDate, "2026-03-15 08:30:00");
    assert.strictEqual(parsed.date, undefined);
    assert.deepStrictEqual(parsed.tags, ["astro"]);
  });

  test("date and pubDate are reported independently when both are present", () => {
    const content = `---
title: Both Keys
date: 2026-07-24 10:00:00
pubDate: 2026-03-15 08:30:00
tags: []
---

Body.
`;
    const parsed = parseEntryContent(content);
    assert.strictEqual(parsed.date, "2026-07-24 10:00:00");
    assert.strictEqual(parsed.pubDate, "2026-03-15 08:30:00");
  });

  test("pubDate does not satisfy the date key and date does not satisfy pubDate", () => {
    const onlyDate = parseEntryContent(SAMPLE);
    assert.strictEqual(onlyDate.date, "2026-07-24 10:00:00");
    assert.strictEqual(onlyDate.pubDate, undefined);

    const onlyPubDate = parseEntryContent(PUB_DATE_SAMPLE);
    assert.strictEqual(onlyPubDate.date, undefined);
  });

  test("quoted pubDate values are unquoted and CRLF does not leak", () => {
    const content = `---
title: Quoted Pub Date
pubDate: '2026-03-15 08:30:00'
tags: []
---

Body.
`.replace(/\n/g, "\r\n");
    const parsed = parseEntryContent(content);
    assert.strictEqual(parsed.pubDate, "2026-03-15 08:30:00");
  });

  test("pubDate is excluded from the indexed body", () => {
    const parsed = parseEntryContent(PUB_DATE_SAMPLE);
    assert.ok(!parsed.body.includes("pubDate:"));
    assert.ok(parsed.body.includes("Astro body content."));
  });
});
