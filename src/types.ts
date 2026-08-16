export interface BlogEntry {
  title: string;
  date: string;
  path: string;
  tags: string[];
}

export type MediaType = "image" | "audio" | "video" | "document";

export interface MediaFile {
  // Forward-slash path relative to the media root (never includes the
  // "media/" prefix itself -- callers prepend that when displaying or
  // copying a blog-relative path).
  path: string;
  name: string;
  type: MediaType;
  size: number;
  mtimeMs: number;
}
