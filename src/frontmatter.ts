export interface ParsedEntry {
  title?: string;
  date?: string;
  pubDate?: string;
  tags: string[];
  body: string;
}

// Regex-based frontmatter parser shared by the watcher, activation
// reconciliation, and full-rescan paths. Not a full YAML parser: it
// understands `title:`, `date:`, `pubDate:`, and `tags:` (inline array
// or single value), which covers the format the extension itself writes
// plus the Astro-style `pubDate:` key. Both date keys are reported as
// parsed; callers decide which one wins.
//
// The returned body excludes the frontmatter block so frontmatter keys
// and values are never indexed as searchable entry content.
export function parseEntryContent(content: string): ParsedEntry {
  // Normalize once so \r\n files match the delimiter and don't leak a
  // trailing \r into title/date/tag values captured below.
  const normalizedContent = content.replace(/\r\n/g, "\n");
  const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*\n/;
  const match = normalizedContent.match(frontmatterRegex);

  if (!match) {
    return { tags: [], body: normalizedContent };
  }

  const frontmatterContent = match[1];
  const body = normalizedContent.slice(match[0].length);
  const result: ParsedEntry = { tags: [], body };

  const titleMatch = frontmatterContent.match(/^title:\s*(.+)$/m);
  if (titleMatch) {
    result.title = stripQuotes(titleMatch[1]);
  }

  const dateMatch = frontmatterContent.match(/^date:\s*(.+)$/m);
  if (dateMatch) {
    result.date = stripQuotes(dateMatch[1]);
  }

  const pubDateMatch = frontmatterContent.match(/^pubDate:\s*(.+)$/m);
  if (pubDateMatch) {
    result.pubDate = stripQuotes(pubDateMatch[1]);
  }

  const tagsMatch = frontmatterContent.match(/^tags:\s*(\[.*?\]|\S+)$/m);
  if (tagsMatch) {
    result.tags = parseTagsValue(tagsMatch[1].trim());
  }

  return result;
}

function stripQuotes(value: string): string {
  return value.trim().replace(/^["']|["']$/g, "");
}

function parseTagsValue(tagsString: string): string[] {
  if (tagsString.startsWith("[") && tagsString.endsWith("]")) {
    // Array format: [tag1, tag2, tag3]
    return tagsString
      .slice(1, -1)
      .split(",")
      .map((tag) => stripQuotes(tag))
      .filter((tag) => tag.length > 0);
  }
  return [stripQuotes(tagsString)].filter((tag) => tag.length > 0);
}
