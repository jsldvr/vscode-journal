import * as assert from "assert";
import * as path from "path";
import * as fc from "fast-check";
import { parseEntryContent } from "../../src/frontmatter";
import { isPathInside, normalizeEntryPath } from "../../src/pathUtils";

const SAFE_CHARACTER = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 -_"
);
const SAFE_TEXT = fc
  .array(SAFE_CHARACTER, { minLength: 1, maxLength: 40 })
  .map((characters) => characters.join("").trim())
  .filter((value) => value.length > 0);

suite("path and frontmatter properties", () => {
  test("normalizing an entry path is idempotent and removes backslashes", () => {
    fc.assert(
      fc.property(fc.string(), (entryPath) => {
        const normalized = normalizeEntryPath(entryPath);
        assert.strictEqual(normalizeEntryPath(normalized), normalized);
        assert.strictEqual(normalized.includes("\\"), false);
      })
    );
  });

  test("joining safe segments below a parent always remains inside it", () => {
    fc.assert(
      fc.property(
        fc.array(SAFE_TEXT, { minLength: 1, maxLength: 8 }),
        (segments) => {
          const parent = path.resolve("property-parent");
          assert.strictEqual(isPathInside(path.join(parent, ...segments), parent), true);
        }
      )
    );
  });

  test("generated extension frontmatter round-trips supported metadata", () => {
    fc.assert(
      fc.property(
        SAFE_TEXT,
        SAFE_TEXT,
        fc.array(SAFE_TEXT, { maxLength: 8 }),
        (title, body, tags) => {
          const content =
            `---\ntitle: ${title}\ndate: 2026-07-26 12:00:00\n` +
            `tags: [${tags.join(", ")}]\n---\n\n${body}`;
          const parsed = parseEntryContent(content);

          assert.strictEqual(parsed.title, title);
          assert.strictEqual(parsed.date, "2026-07-26 12:00:00");
          assert.deepStrictEqual(parsed.tags, tags);
          assert.strictEqual(parsed.body, body);
        }
      )
    );
  });
});
