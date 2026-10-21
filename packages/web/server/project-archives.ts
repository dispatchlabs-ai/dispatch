import { createHash, randomUUID } from "node:crypto";
import { mkdir, open } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, join } from "node:path";
import { defineDoc } from "@earendil-works/pi-durable";
import { z } from "zod";
import { PROJECT_ARCHIVE_MAX_BYTES, type ProjectArchive, type ProjectArchivePreview } from "../src/shared/project-archives.js";

export class ProjectArchiveError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const key = z.string().regex(/^[a-z][a-z0-9-]{0,79}$/);
const timestamp = z.number().int().min(0).max(8640000000000000);
const file = z.object({ key, name: z.string().min(1).max(200), mimeType: z.string().max(200), size: z.number().int().min(0).max(10 * 1024 * 1024), sha256: z.string().regex(/^[a-f0-9]{64}$/), data: z.string().max(14 * 1024 * 1024) }).strict();
const chat = z.object({ key, title: z.string().min(1).max(200), authors: z.array(z.object({ key, name: z.string().min(1).max(200), kind: z.enum(["human", "agent", "unknown"]) }).strict()).max(1000),
  messages: z.array(z.object({ key, author: key, kind: z.enum(["message", "membership"]), text: z.string().max(100000), createdAt: timestamp, thread: key.nullable(), mentions: z.array(key).max(1000), files: z.array(key).max(10) }).strict()).max(10000), files: z.array(file).max(1000) }).strict();
const schema = z.object({ format: z.literal("dispatch-project-content"), version: z.literal(1), name: z.string().trim().min(1).max(100), exportedAt: timestamp, chats: z.array(chat).max(100) }).strict();
export const archiveDigest = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
export function decodeProjectArchive(text: string): ProjectArchive {
  if (Buffer.byteLength(text) > PROJECT_ARCHIVE_MAX_BYTES) throw new ProjectArchiveError(413, "Project archives must be 32 MiB or smaller.");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new ProjectArchiveError(400, "Choose a valid project JSON archive."); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ProjectArchiveError(400, "Invalid project archive format or limits.");
  const archive = parsed.data;
  unique(archive.chats);
  let messages = 0; let files = 0;
  for (const chat of archive.chats) {
    const authors = unique(chat.authors); const ids = unique(chat.messages); const fileIds = unique(chat.files); const referenced = new Set<string>();
    messages += chat.messages.length; files += chat.files.length;
    if (messages > 10000 || files > 1000) throw new ProjectArchiveError(413, "Archive exceeds 10,000 messages or 1,000 files.");
    for (const message of chat.messages) {
      if (!authors.has(message.author) || message.mentions.some(id => !authors.has(id)) || (message.thread !== null && (!ids.has(message.thread) || message.thread === message.key)) || message.files.some(id => !fileIds.has(id))) throw new ProjectArchiveError(400, "Archive contains an unresolved reference.");
      message.files.forEach(id => referenced.add(id));
    }
    for (const item of chat.files) {
      const bytes = Buffer.from(item.data, "base64");
      if (bytes.toString("base64") !== item.data || bytes.length !== item.size || archiveDigest(bytes) !== item.sha256 || !referenced.has(item.key)) throw new ProjectArchiveError(400, "Archive attachment is corrupt or unreferenced.");
    }
  }
  return archive;
}
function unique(items: { key: string }[]) {
  const keys = new Set(items.map(item => item.key));
  if (keys.size !== items.length) throw new ProjectArchiveError(400, "Archive keys must be unique.");
  return keys;
}
export function projectArchivePreview(archive: ProjectArchive): ProjectArchivePreview {
  return { name: archive.name, bytes: Buffer.byteLength(JSON.stringify(archive)), chats: archive.chats.map(chat => ({ title: chat.title, messages: chat.messages.length, files: chat.files.length, authors: chat.authors.map(author => author.name) })) };
}
export type ArchiveBlob = { id: string; digest: string };
/** Storage owns immutable bytes; callers own authorization and atomic catalog admission. */
export interface ProjectArchiveStorage {
  save(archive: ProjectArchive): Promise<ArchiveBlob>;
  read(blob: ArchiveBlob): Promise<ProjectArchive>;
}
export const ProjectArchivesDoc = defineDoc<{ records: Record<string, ArchiveBlob> }>({ kind: "dispatch.project-archives", version: 1, scope: "session", initial: () => ({ records: {} }) });

/** Immutable content (including file bytes) precedes atomic native admission. Orphans are never visible. */
export class ProjectArchiveStore implements ProjectArchiveStorage {
  constructor(private readonly directory: string) {}
  async save(archive: ProjectArchive): Promise<ArchiveBlob> {
    const text = JSON.stringify(archive);
    if (Buffer.byteLength(text) > PROJECT_ARCHIVE_MAX_BYTES) throw new ProjectArchiveError(413, "Project archive exceeds 32 MiB.");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const parent = await open(dirname(this.directory), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
    const id = randomUUID(); const handle = await open(join(this.directory, id), "wx", 0o600);
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    const directory = await open(this.directory, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    return { id, digest: archiveDigest(text) };
  }
  async read(blob: ArchiveBlob): Promise<ProjectArchive> {
    if (!/^[a-f0-9-]{36}$/.test(blob.id)) throw new ProjectArchiveError(410, "Invalid stored archive reference.");
    const handle = await open(join(this.directory, blob.id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > PROJECT_ARCHIVE_MAX_BYTES) throw new ProjectArchiveError(410, "Stored archive is unavailable.");
      const bytes = await handle.readFile();
      if (archiveDigest(bytes) !== blob.digest) throw new ProjectArchiveError(410, "Stored archive integrity check failed.");
      return decodeProjectArchive(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } finally { await handle.close(); }
  }
}
