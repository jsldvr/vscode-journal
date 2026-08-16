// Pure structural validation for the media-related messages inbound on
// the combined Journal webview. Type names are "media"-prefixed
// because they share one message channel and one "ready" handshake
// with the entries half of the webview (see webviewSupport.ts) -- a
// bare "open" or "refresh" would be ambiguous between opening an entry
// and opening a media file. Mirrors webviewSupport.ts's precedent:
// this layer checks shape (known type, bounded string fields) only --
// it deliberately does not evaluate path semantics (traversal,
// absolute paths, symlinks). That containment gate lives in
// mediaLibrary.ts's resolveContainedMediaFilePath, which every action
// handler must call before touching the filesystem. Kept free of
// vscode imports so the unit suite can exercise it directly.

const MAX_PATH_STRING_LENGTH = 4096;

export interface MediaRefreshMessage {
  type: "mediaRefresh";
}

export interface MediaUploadMessage {
  type: "mediaUpload";
}

// Sent by the sidebar grid when a tile is clicked/keyboard-activated.
// Stateless on the sidebar side -- selection is not tracked or
// persisted there; this just requests that the editor-area details
// panel be opened/updated for this file.
export interface MediaSelectMessage {
  type: "mediaSelect";
  path: string;
}

export interface MediaOpenMessage {
  type: "mediaOpen";
  path: string;
}

export interface MediaRevealMessage {
  type: "mediaReveal";
  path: string;
}

export interface MediaCopyPathMessage {
  type: "mediaCopyPath";
  path: string;
}

export interface MediaDeleteMessage {
  type: "mediaDelete";
  path: string;
}

export type InboundMediaMessage =
  | MediaRefreshMessage
  | MediaUploadMessage
  | MediaSelectMessage
  | MediaOpenMessage
  | MediaRevealMessage
  | MediaCopyPathMessage
  | MediaDeleteMessage;

type MediaMessageValidator = (
  message: Record<string, unknown>
) => InboundMediaMessage | undefined;

function pathMessageValidator(
  type: "mediaSelect" | "mediaOpen" | "mediaReveal" | "mediaCopyPath" | "mediaDelete"
): MediaMessageValidator {
  return (message) => {
    const mediaPath = boundedPathString(message.path);
    return mediaPath === undefined ? undefined : { type, path: mediaPath };
  };
}

const MEDIA_MESSAGE_VALIDATORS: Record<string, MediaMessageValidator> = {
  mediaRefresh: () => ({ type: "mediaRefresh" }),
  mediaUpload: () => ({ type: "mediaUpload" }),
  mediaSelect: pathMessageValidator("mediaSelect"),
  mediaOpen: pathMessageValidator("mediaOpen"),
  mediaReveal: pathMessageValidator("mediaReveal"),
  mediaCopyPath: pathMessageValidator("mediaCopyPath"),
  mediaDelete: pathMessageValidator("mediaDelete"),
};

// Returns a typed message only when the raw value is structurally
// valid and its type is one of the media-prefixed names; anything else
// (wrong shape, unknown/non-media type, non-string or oversized
// fields) is rejected with undefined and must be ignored. Callers try
// the entries validator (webviewSupport.ts) first since the two
// vocabularies are disjoint by the "media" prefix.
export function validateMediaMessage(
  raw: unknown
): InboundMediaMessage | undefined {
  if (typeof raw !== "object" || raw === null) {
    return undefined;
  }
  const message = raw as Record<string, unknown>;
  if (typeof message.type !== "string") {
    return undefined;
  }
  const validator = MEDIA_MESSAGE_VALIDATORS[message.type];
  return validator ? validator(message) : undefined;
}

function boundedPathString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (value.length > MAX_PATH_STRING_LENGTH) {
    return undefined;
  }
  return value;
}
