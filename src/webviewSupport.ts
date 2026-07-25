// Pure helpers for the search webview: message validation for
// everything crossing the webview boundary, and HTML escaping for any
// text that ends up in markup. Kept free of vscode imports so the unit
// suite can exercise them directly.

const MAX_MESSAGE_STRING_LENGTH = 2000;

export interface SearchMessage {
  type: "search";
  query: string;
  matchCase?: boolean;
  wholeWord?: boolean;
  useRegex?: boolean;
}

export interface ClearMessage {
  type: "clear";
}

export interface OpenMessage {
  type: "open";
  path: string;
}

export interface TagMessage {
  type: "tag";
  tag: string;
}

export interface ReadyMessage {
  type: "ready";
}

export interface NewEntryMessage {
  type: "newEntry";
}

export type InboundWebviewMessage =
  | SearchMessage
  | ClearMessage
  | OpenMessage
  | TagMessage
  | ReadyMessage
  | NewEntryMessage;

type MessageValidator = (
  message: Record<string, unknown>
) => InboundWebviewMessage | undefined;

const MESSAGE_VALIDATORS: Record<string, MessageValidator> = {
  ready: () => ({ type: "ready" }),
  clear: () => ({ type: "clear" }),
  newEntry: () => ({ type: "newEntry" }),
  search: (message) => {
    const query = boundedString(message.query);
    if (query === undefined) {
      return undefined;
    }
    if (
      !isOptionalBoolean(message.matchCase) ||
      !isOptionalBoolean(message.wholeWord) ||
      !isOptionalBoolean(message.useRegex)
    ) {
      return undefined;
    }
    const result: SearchMessage = { type: "search", query };
    if (message.matchCase !== undefined) {
      result.matchCase = message.matchCase as boolean;
    }
    if (message.wholeWord !== undefined) {
      result.wholeWord = message.wholeWord as boolean;
    }
    if (message.useRegex !== undefined) {
      result.useRegex = message.useRegex as boolean;
    }
    return result;
  },
  open: (message) => {
    const entryPath = boundedString(message.path);
    return entryPath === undefined
      ? undefined
      : { type: "open", path: entryPath };
  },
  tag: (message) => {
    const tag = boundedString(message.tag);
    return tag === undefined ? undefined : { type: "tag", tag };
  },
};

// Returns a typed message only when the raw value is structurally
// valid; anything else (wrong shape, unknown type, non-string or
// oversized fields) is rejected with undefined and must be ignored.
export function validateWebviewMessage(
  raw: unknown
): InboundWebviewMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const message = raw as Record<string, unknown>;
  if (typeof message.type !== "string") {
    return undefined;
  }
  const validator = MESSAGE_VALIDATORS[message.type];
  return validator ? validator(message) : undefined;
}

function isOptionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === "boolean";
}

function boundedString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  if (value.length > MAX_MESSAGE_STRING_LENGTH) {
    return undefined;
  }
  return value;
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
