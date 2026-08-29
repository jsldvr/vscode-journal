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
// The dynamic label and target are emitted as literal (escaped) snippet
// text; only the alt-text placeholder is real snippet syntax. For an
// ordinary filename the output matches the documented examples exactly.
export function buildMediaSnippetBody(input: MediaSnippetInput): string {
  const target = escapeSnippetText(input.target);
  if (input.isImage) {
    return `![\${1:alt text}](${target})`;
  }
  return `[${escapeSnippetText(input.label)}](${target})`;
}
