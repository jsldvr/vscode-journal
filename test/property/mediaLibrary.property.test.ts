import * as assert from "assert";
import * as fs from "fs-extra";
import * as fc from "fast-check";
import * as os from "os";
import * as path from "path";
import {
  classifyMediaType,
  ImportResult,
  importMediaFile,
  resolveContainedMediaFilePath,
} from "../../src/mediaLibrary";

const SAFE_CHARACTER = fc.constantFrom(
  ..."abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
);
const SAFE_SEGMENT = fc
  .array(SAFE_CHARACTER, { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(""));

async function makeTempDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "vs-journal-media-prop-"));
}

suite("mediaLibrary properties", () => {
  test("classifyMediaType always returns one of the four known types", () => {
    fc.assert(
      fc.property(fc.string(), (filename) => {
        const type = classifyMediaType(filename);
        assert.ok(["image", "audio", "video", "document"].includes(type));
      })
    );
  });

  test("classifyMediaType is case-insensitive on the extension", () => {
    fc.assert(
      fc.property(SAFE_SEGMENT, fc.constantFrom("png", "MP3", "Mp4", "PDF"), (base, ext) => {
        const lower = classifyMediaType(`${base}.${ext.toLowerCase()}`);
        const upper = classifyMediaType(`${base}.${ext.toUpperCase()}`);
        assert.strictEqual(lower, upper);
      })
    );
  });

  test("a relative path containing a traversal segment never resolves inside the media root", async () => {
    const mediaRoot = await makeTempDir();
    try {
      await fs.writeFile(path.join(path.dirname(mediaRoot), "escaped.txt"), "secret");
      await fc.assert(
        fc.asyncProperty(
          fc.array(SAFE_SEGMENT, { minLength: 0, maxLength: 4 }),
          fc.integer({ min: 1, max: 4 }),
          async (segments, escapeDepth) => {
            const traversal = Array(escapeDepth).fill("..").concat(segments, "escaped.txt");
            const relativePath = traversal.join("/");
            const resolved = await resolveContainedMediaFilePath(mediaRoot, relativePath);
            assert.strictEqual(resolved, undefined);
          }
        )
      );
    } finally {
      await fs.remove(mediaRoot);
      await fs.remove(path.join(path.dirname(mediaRoot), "escaped.txt")).catch(() => undefined);
    }
  });

  test("importing N files sharing a base filename always yields N distinct paths and preserves each file's own bytes", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.string({ minLength: 1, maxLength: 20 }), { minLength: 2, maxLength: 6 }),
        async (contents) => {
          const mediaRoot = await makeTempDir();
          const sourceDir = await makeTempDir();
          try {
            const results: ImportResult[] = [];
            for (const content of contents) {
              const sourcePath = path.join(sourceDir, `src-${results.length}.png`);
              await fs.writeFile(sourcePath, content);
              results.push(await importMediaFile(mediaRoot, sourcePath, "shared.png"));
            }

            const paths = results.map((r) => r.path);
            assert.strictEqual(new Set(paths).size, paths.length);

            for (let i = 0; i < results.length; i++) {
              const actual = await fs.readFile(results[i].absolutePath, "utf8");
              assert.strictEqual(actual, contents[i]);
            }
          } finally {
            await fs.remove(mediaRoot);
            await fs.remove(sourceDir);
          }
        }
      ),
      { numRuns: 20 }
    );
  });
});
