// Pure, vscode-free construction of the Markdown snippet body inserted
// at the active journal-entry cursor(s) when a media tile is activated.
// Kept free of vscode imports so the unit suite can assert the exact
// emitted text -- including snippet-metacharacter escaping -- directly.
// MediaController (mediaView.ts) wraps the returned string in
// vscode.SnippetString and applies it with TextEditor.insertSnippet.

export interface MediaSnippetInput {
  // Determined from trusted, revalidated file information (media
  // classification), never a type supplied by the webview.
  isImage: boolean;
  // Link label for a non-image file: the selected file's basename,
  // including its extension. Ignored for an image, whose label is an
  // editable snippet placeholder instead.
  label: string;
  // Portable, forward-slash link target already composed from the
  // blog-relative media directory and the media-relative file path.
  target: string;
}

// Escapes the three characters VS Code snippet syntax treats specially
// -- "$" (tabstop/variable), "}" (placeholder close), and "\" (the
// escape character itself) -- so a filename or path containing them is
// inserted literally rather than interpreted as snippet syntax.
// Backslash is escaped first so the backslashes this function
// introduces for "$" and "}" are not doubled again.
export function escapeSnippetText(text: string): string {
  return text
    .replace(/\\/g, "\\\\")
    .replace(/\$/g, "\\$")
    .replace(/\}/g, "\\}");
}

// Percent-encodes a forward-slash link destination for Markdown: each
// "/"-separated segment is encoded (so a space, "#", "?", "%" etc. in a
// filename or a configured media path cannot break the "(...)"
// destination) while the "/" separators are preserved. encodeURIComponent
// leaves "(" and ")" untouched, so those are additionally encoded here --
// an unbalanced parenthesis in a filename would otherwise terminate the
// link early.
export function encodeMarkdownDestination(destination: string): string {
  return destination
    .split("/")
    .map((segment) =>
      encodeURIComponent(segment).replace(/\(/g, "%28").replace(/\)/g, "%29")
    )
    .join("/");
}

// Backslash-escapes the characters that would otherwise terminate or
// misparse a "[...]" Markdown link label: "\", "[", and "]". Applied
// before snippet escaping so the backslashes it introduces survive as
// literal backslashes through the snippet layer.
export function escapeMarkdownLinkText(text: string): string {
  return text.replace(/[\\[\]]/g, (character) => `\\${character}`);
}

// Joins the portable media-directory path (blog-relative, e.g. "media"
// or "assets/uploads") and the media-relative file path into a single
// forward-slash link target. Both parts are already normalized to
// forward slashes and non-empty; this only inserts the separator.
export function composeMediaTarget(
  portableMediaDir: string,
  mediaRelativePath: string
): string {
  return `${portableMediaDir}/${mediaRelativePath}`;
}

// Image:  ![${1:alt text}](target)  -- "alt text" is an editable
//         placeholder selected for immediate replacement.
// Other:  [basename](target)
// The destination is percent-encoded and the non-image label is
// Markdown-escaped so an arbitrary uploaded filename (spaces,
// parentheses, brackets, "#", ...) still yields a valid link; both are
// then snippet-escaped so nothing dynamic is parsed as snippet syntax.
// Only the alt-text placeholder is real snippet syntax. For an ordinary
// filename the output matches the documented examples exactly.
export function buildMediaSnippetBody(input: MediaSnippetInput): string {
  const target = escapeSnippetText(encodeMarkdownDestination(input.target));
  if (input.isImage) {
    return `![\${1:alt text}](${target})`;
  }
  const label = escapeSnippetText(escapeMarkdownLinkText(input.label));
  return `[${label}](${target})`;
}
