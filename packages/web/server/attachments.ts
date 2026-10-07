import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { toUSVString } from "node:util";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { defineDoc, type ConversationId, type Tx } from "@earendil-works/pi-durable";
import { ATTACHMENT_MAX_BYTES, ATTACHMENT_MAX_COUNT, ATTACHMENT_TOTAL_MAX_BYTES, ATTACHMENT_IMAGE_MAX_BYTES, ATTACHMENT_IMAGE_TOTAL_MAX_BYTES, type Attachment } from "../src/shared/contracts.js";

export type StoredAttachment = Attachment & { uploaderId: string; createdAt: number; private?: boolean };
export const AttachmentsDoc = defineDoc<{ records: Record<string, StoredAttachment> }>({
  kind: "dispatch.attachments", version: 1, scope: "conversation", history: "latest", fork: "initial", initial: () => ({ records: {} }),
});
export class AttachmentError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const multipartMaxBytes = ATTACHMENT_MAX_BYTES + 64 * 1024;

/** Count actual streamed bytes, including when Content-Length is missing or dishonest. */
export async function readAttachmentUpload(request: Request): Promise<File> {
  if (Number(request.headers.get("content-length")) > multipartMaxBytes) throw new AttachmentError(413, "File exceeds the 10 MiB upload limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new AttachmentError(400, "Choose a file to upload.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > multipartMaxBytes) {
        await reader.cancel();
        throw new AttachmentError(413, "File exceeds the 10 MiB upload limit.");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  let form: FormData;
  try { form = await new Response(Buffer.concat(chunks), { headers: { "Content-Type": request.headers.get("content-type") ?? "" } }).formData(); }
  catch { throw new AttachmentError(400, "Use a multipart request containing one file."); }
  const entries = [...form.entries()];
  if (entries.length !== 1 || entries[0][0] !== "file" || !(entries[0][1] instanceof File)) throw new AttachmentError(400, "Upload exactly one file in the file field.");
  const file = entries[0][1];
  if (file.size > ATTACHMENT_MAX_BYTES) throw new AttachmentError(413, "Files must be 10 MiB or smaller.");
  return file;
}

/** Immutable bytes precede native metadata admission. A crash may leave an unreferenced blob, never a published partial file. */
export class AttachmentStore {
  constructor(private readonly directory: string) {}

  async save(conversationId: string, uploaderId: string, file: File): Promise<StoredAttachment> {
    if (file.size > ATTACHMENT_MAX_BYTES) throw new AttachmentError(413, "Files must be 10 MiB or smaller.");
    const bytes = Buffer.from(await file.arrayBuffer());
    const format = classify(bytes, file.type);
    const id = randomUUID();
    const name = Array.from(toUSVString(file.name).replace(/[\\/\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "_").trim()).slice(0, 200).join("") || "attachment";
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const handle = await open(join(this.directory, id), "wx", 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    return { id, name, ...format, size: bytes.byteLength, uploaderId, createdAt: Date.now(), url: `/api/chats/${encodeURIComponent(conversationId)}/attachments/${id}` };
  }

  /** Snapshot bytes once; publication never reads the mutable source again. Not a process sandbox. */
  async saveWorkspace(conversationId: string, uploaderId: string, workspace: string, path: string, signal?: AbortSignal): Promise<StoredAttachment> {
    signal?.throwIfAborted();
    if (!workspace || !path || isAbsolute(path)) throw new AttachmentError(400, "Choose a workspace-relative file path.");
    const root = await realpath(workspace);
    const source = await realpath(resolve(root, path));
    const within = relative(root, source);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new AttachmentError(400, "File must be inside the workspace.");
    // Refuse final-component symlink replacement and special files; parent-directory races remain a service-account boundary.
    const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new AttachmentError(400, "Choose a regular file.");
      if (info.size > ATTACHMENT_MAX_BYTES) throw new AttachmentError(413, "Files must be 10 MiB or smaller.");
      const buffer = Buffer.alloc(ATTACHMENT_MAX_BYTES + 1);
      let length = 0;
      while (length < buffer.length) {
        signal?.throwIfAborted();
        const result = await handle.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > ATTACHMENT_MAX_BYTES) throw new AttachmentError(413, "Files must be 10 MiB or smaller.");
      bytes = buffer.subarray(0, length);
    } finally { await handle.close(); }
    signal?.throwIfAborted();
    const record = await this.save(conversationId, uploaderId, new File([new Uint8Array(bytes)], basename(path)));
    return { ...record, private: true };
  }

  async read(attachment: Attachment): Promise<Buffer> {
    if (!uuid.test(attachment.id)) throw new AttachmentError(404, "Attachment not found.");
    try { return await readFile(join(this.directory, attachment.id)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new AttachmentError(410, "Attachment bytes are unavailable. Restore the complete state directory from backup.");
      throw error;
    }
  }

  async imageContent(attachments: readonly Attachment[] = []): Promise<(ImageContent | TextContent)[]> {
    const content: (ImageContent | TextContent)[] = [];
    let includedBytes = 0;
    for (const attachment of attachments) {
      if (attachment.kind !== "image") continue;
      const tooLarge = attachment.size > ATTACHMENT_IMAGE_MAX_BYTES;
      if (tooLarge || includedBytes + attachment.size > ATTACHMENT_IMAGE_TOTAL_MAX_BYTES) {
        content.push({ type: "text", text: JSON.stringify({ attachmentId: attachment.id, name: attachment.name, imageOmitted: true,
          reason: tooLarge ? "Image exceeds the 4 MiB model-input limit. The original remains downloadable; ask for a smaller upload."
            : "Image exceeds this delivery's 8 MiB image budget. Use conversation_attachment with this attachmentId to read it separately." }) });
        continue;
      }
      content.push({ type: "image", mimeType: attachment.mimeType, data: (await this.read(attachment)).toString("base64") });
      includedBytes += attachment.size;
    }
    return content;
  }
}

export function attachmentMetadata({ uploaderId: _uploaderId, createdAt: _createdAt, private: _private, ...metadata }: StoredAttachment): Attachment { return metadata; }

/** Call only after authorizing the conversation on this transaction. */
export async function messageAttachments(tx: Tx, roomId: ConversationId, uploaderId: string, ids: string[] = []): Promise<Attachment[]> {
  if (ids.length > ATTACHMENT_MAX_COUNT || new Set(ids).size !== ids.length || ids.some(id => !uuid.test(id))) throw new AttachmentError(400, "Choose up to 10 distinct attachments.");
  if (!ids.length) return [];
  const { records } = await tx.doc(AttachmentsDoc, roomId);
  const attachments = ids.map(id => {
    const record = records[id];
    if (!record || record.uploaderId !== uploaderId) throw new AttachmentError(404, "Attachment not found for this sender and conversation.");
    return attachmentMetadata(record);
  });
  if (attachments.reduce((size, attachment) => size + attachment.size, 0) > ATTACHMENT_TOTAL_MAX_BYTES) throw new AttachmentError(413, "Attachments in one message must total 25 MiB or less.");
  return attachments;
}

/** UTF-8 alone includes binary control bytes; exclude those before exposing content as text. */
function utf8(bytes: Buffer): boolean {
  try { return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { return false; }
}
function classify(bytes: Buffer, declaredType: string): Pick<Attachment, "kind" | "mimeType"> {
  const declared = declaredType.toLowerCase().split(";")[0].trim();
  const specified = declared !== "" && declared !== "application/octet-stream";
  const image = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
    : bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff ? "image/jpeg"
    : ["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString("ascii")) ? "image/gif"
    : bytes.subarray(0, 4).toString("ascii") === "RIFF" && bytes.subarray(8, 12).toString("ascii") === "WEBP" ? "image/webp" : undefined;
  const mismatch = () => { throw new AttachmentError(415, "The file content does not match its declared type."); };
  if (image) {
    if (specified && declared !== image && !(image === "image/jpeg" && declared === "image/jpg")) mismatch();
    return { kind: "image", mimeType: image };
  }
  // SVG is never an inline image or a model-readable text attachment.
  if (["image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp"].includes(declared)) mismatch();
  const pdf = bytes.subarray(0, 5).toString("ascii") === "%PDF-";
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b && ((bytes[2] === 3 && bytes[3] === 4) || (bytes[2] === 5 && bytes[3] === 6) || (bytes[2] === 7 && bytes[3] === 8));
  if (pdf || zip) {
    const compatible = pdf ? declared === "application/pdf" : ["application/zip", "application/x-zip-compressed"].includes(declared) || declared.startsWith("application/vnd.openxmlformats-officedocument.") || declared.startsWith("application/vnd.oasis.opendocument.");
    if (specified && !compatible) mismatch();
    return { kind: "file", mimeType: pdf ? "application/pdf" : "application/zip" };
  }
  if (["application/pdf", "application/zip", "application/x-zip-compressed"].includes(declared)) mismatch();
  const text = utf8(bytes);
  if (!text && (declared.startsWith("text/") || ["application/json", "application/xml", "application/javascript", "image/svg+xml"].includes(declared))) mismatch();
  if (declared.startsWith("image/") || (text && /<svg(?:\s|\/|>)/i.test(bytes.toString("utf8")))) return { kind: "file", mimeType: "application/octet-stream" };
  return text ? { kind: "text", mimeType: "text/plain; charset=utf-8" } : { kind: "file", mimeType: "application/octet-stream" };
}
