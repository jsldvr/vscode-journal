import * as assert from "assert";
import {
  buildMediaSnippetBody,
  composeMediaTarget,
  encodeMarkdownDestination,
  escapeMarkdownLinkText,
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

  test("encodeMarkdownDestination percent-encodes each segment but preserves the slashes", () => {
    assert.strictEqual(
      encodeMarkdownDestination("assets/my uploads/pic 2.png"),
      "assets/my%20uploads/pic%202.png"
    );
  });

  test("encodeMarkdownDestination encodes parentheses, #, ? and % that would break a (...) destination", () => {
    assert.strictEqual(
      encodeMarkdownDestination("media/note (1)#draft?.png"),
      "media/note%20%281%29%23draft%3F.png"
    );
  });

  test("escapeMarkdownLinkText backslash-escapes brackets and backslashes only", () => {
    assert.strictEqual(escapeMarkdownLinkText("a[b].pdf"), "a\\[b\\].pdf");
    assert.strictEqual(escapeMarkdownLinkText("a(b) c.pdf"), "a(b) c.pdf");
  });

  test("a common filename with spaces and parentheses still yields a valid image link", () => {
    assert.strictEqual(
      buildMediaSnippetBody({
        isImage: true,
        label: "screen shot (1).png",
        target: "media/screen shot (1).png",
      }),
      "![${1:alt text}](media/screen%20shot%20%281%29.png)"
    );
  });

  test("a non-image label's Markdown brackets are escaped and its destination percent-encoded", () => {
    assert.strictEqual(
      buildMediaSnippetBody({
        isImage: false,
        label: "a[b].pdf",
        target: "media/a[b].pdf",
      }),
      "[a\\\\[b\\\\].pdf](media/a%5Bb%5D.pdf)"
    );
  });

  test("dynamic snippet metacharacters in the label are emitted as literal snippet text", () => {
    assert.strictEqual(
      buildMediaSnippetBody({
        isImage: false,
        label: "a$b}c.txt",
        target: "media/a$b}c.txt",
      }),
      "[a\\$b\\}c.txt](media/a%24b%7Dc.txt)"
    );
  });
});
