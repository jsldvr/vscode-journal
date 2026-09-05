// Pure, dependency-free regex matching primitives shared by the
// extension host and the isolated regex-search worker. This module must
// never import anything with a runtime side effect (sqlite3, fs-extra,
// vscode): the worker thread loads it in isolation and pulling in the
// native SQLite binding or the VS Code API there would be both wasteful
// and, for sqlite3, a second native initialization.

// Snippet highlight markers. The webview splits on these control
// characters and wraps the highlighted ranges; they never survive into
// rendered HTML.
export const SNIPPET_START = "\u0001";
export const SNIPPET_END = "\u0002";

export const JS_SNIPPET_RADIUS = 30;

// Thrown when useRegex is set and the query does not compile; callers
// surface this as a friendly inline message instead of a generic
// search failure.
export class InvalidSearchPatternError extends Error {}

export interface SearchToggleOptions {
  matchCase?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}

// The final, already-escaped/bounded RegExp inputs. Serializable across
// the worker boundary (a compiled RegExp is not).
export interface RegexPatternSpec {
  source: string;
  flags: string;
}

export interface RegexSearchRow {
  path: string;
  title: string;
  body: string;
}

export interface RegexSearchHit {
  path: string;
  snippet: string;
}

// One regex-search request: every candidate row, the pattern, and the
// hit cap. Preserves the previous searchWithPattern contract.
export interface RegexSearchJob {
  rows: RegexSearchRow[];
  spec: RegexPatternSpec;
  limit: number;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Translates a user query plus toggle state into the final RegExp
// source/flags: literal text is escaped unless useRegex is set,
// wholeWord wraps the whole pattern in word boundaries, and matchCase
// toggles the "i" flag. Mirrors the previous buildSearchPattern so
// search semantics are unchanged.
export function buildPatternSpec(
  query: string,
  options: SearchToggleOptions
): RegexPatternSpec {
  const source = options.useRegex ? query : escapeRegExp(query);
  const bounded = options.wholeWord ? `\\b(?:${source})\\b` : source;
  return { source: bounded, flags: options.matchCase ? "" : "i" };
}

// Compiles a spec, normalizing RegExp's SyntaxError to the friendly
// InvalidSearchPatternError so callers don't need to know RegExp's
// error shape. RegExp *compilation* is not the catastrophic-backtracking
// risk -- that is matching, which runs only inside the worker.
export function compilePattern(spec: RegexPatternSpec): RegExp {
  try {
    return new RegExp(spec.source, spec.flags);
  } catch {
    throw new InvalidSearchPatternError("Invalid regular expression");
  }
}

export function truncatedHead(body: string): string {
  const head = body.slice(0, JS_SNIPPET_RADIUS * 2).trim();
  return head.length < body.trim().length ? `${head}...` : head;
}

// Snippet for the matchCase/wholeWord/useRegex scan, built from a
// RegExpExecArray instead of a literal query. A zero-length match (an
// all-optional regex) is treated the same as "no match" -- there is
// nothing meaningful to highlight.
export function makeMatchSnippet(
  body: string,
  match: RegExpExecArray | null
): string {
  if (!match || match[0].length === 0) {
    return truncatedHead(body);
  }
  const position = match.index;
  const length = match[0].length;
  const start = Math.max(0, position - JS_SNIPPET_RADIUS);
  const end = Math.min(body.length, position + length + JS_SNIPPET_RADIUS);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < body.length ? "..." : "";
  const before = body.slice(start, position);
  const matched = body.slice(position, position + length);
  const after = body.slice(position + length, end);
  return `${prefix}${before}${SNIPPET_START}${matched}${SNIPPET_END}${after}${suffix}`;
}

// The CPU-bound step. A catastrophic pattern can wedge the calling
// thread here synchronously, before exec() returns, which is why this
// is invoked only from the worker thread: the host enforces a deadline
// and reclaims the worker with terminate(). Iterates in the caller's
// row order (date descending) and stops at `limit` hits, matching the
// previous in-memory scan exactly.
export function runRegexSearch(job: RegexSearchJob): RegexSearchHit[] {
  const pattern = compilePattern(job.spec);
  const hits: RegexSearchHit[] = [];
  for (const row of job.rows) {
    const bodyMatch = pattern.exec(row.body);
    if (!bodyMatch && !pattern.test(row.title)) {
      continue;
    }
    hits.push({ path: row.path, snippet: makeMatchSnippet(row.body, bodyMatch) });
    if (hits.length >= job.limit) {
      break;
    }
  }
  return hits;
}
