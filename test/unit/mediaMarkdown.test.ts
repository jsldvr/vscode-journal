import * as assert from "assert";
import {
  buildMediaSnippetBody,
  composeMediaTarget,
  escapeSnippetText,
} from "../../src/mediaMarkdown";

suite("mediaMarkdown", () => {
  test("an image produces an ![alt text](target) snippet with an editable placeholder", () => {
    assert.strictEqual(
      buildMediaSnippetBody({
        isImage: true,
        label: "image.png",
        target: "media/image.png",
      }),
      "![${1:alt text}](media/image.png)"
    );
  });

  test("a non-image produces a [basename](target) snippet using the file's basename", () => {
    assert.strictEqual(
      buildMediaSnippetBody({
        isImage: false,
        label: "file.pdf",
        target: "media/file.pdf",
      }),
      "[file.pdf](media/file.pdf)"
    );
  });

  test("composeMediaTarget joins a configured nested media directory with a forward slash", () => {
    assert.strictEqual(
      composeMediaTarget("assets/uploads", "photo.png"),
      "assets/uploads/photo.png"
    );
  });

  test("composeMediaTarget preserves an already forward-slashed nested file path", () => {
    assert.strictEqual(
      composeMediaTarget("media", "2026/08/pic.png"),
      "media/2026/08/pic.png"
    );
  });

  test("a configured media directory yields an equivalent portable target in the snippet", () => {
    assert.strictEqual(
      buildMediaSnippetBody({
        isImage: true,
        label: "diagram.svg",
        target: composeMediaTarget("assets/uploads", "diagram.svg"),
      }),
      "![${1:alt text}](assets/uploads/diagram.svg)"
    );
  });

  test("escapeSnippetText escapes $, } and backslash so they are not parsed as snippet syntax", () => {
    assert.strictEqual(
      escapeSnippetText("a$b}c\\d"),
      "a\\$b\\}c\\\\d"
    );
  });

  test("dynamic label and target metacharacters are emitted as literal snippet text", () => {
    assert.strictEqual(
      buildMediaSnippetBody({
        isImage: false,
        label: "wei$rd}na\\me.txt",
        target: "media/wei$rd}na\\me.txt",
      }),
      "[wei\\$rd\\}na\\\\me.txt](media/wei\\$rd\\}na\\\\me.txt)"
    );
  });

  test("an image target containing snippet metacharacters is escaped", () => {
    assert.strictEqual(
      buildMediaSnippetBody({
        isImage: true,
        label: "x.png",
        target: "media/a$b/x.png",
      }),
      "![${1:alt text}](media/a\\$b/x.png)"
    );
  });
});
