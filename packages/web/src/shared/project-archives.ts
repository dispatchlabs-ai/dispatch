export const PROJECT_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024;
export interface ProjectArchive {
  format: "dispatch-project-content";
  version: 1;
  name: string;
  exportedAt: number;
  chats: ArchivedChat[];
}
export interface ArchivedChat {
  key: string;
  title: string;
  authors: { key: string; name: string; kind: "human" | "agent" | "unknown" }[];
  messages: {
    key: string; author: string; kind: "message" | "membership"; text: string; createdAt: number;
    thread: string | null; mentions: string[]; files: string[];
  }[];
  files: { key: string; name: string; mimeType: string; size: number; sha256: string; data: string }[];
}
export interface ProjectArchivePreview { name: string; chats: { title: string; messages: number; files: number; authors: string[] }[]; bytes: number }
