import { z } from "zod";
import { AttachmentError, AttachmentStore, type StoredAttachment } from "../attachments.js";
import { ATTACHMENT_MAX_BYTES, type Attachment } from "../../src/shared/contracts.js";

/** A 10 MiB blob plus base64 expansion and bounded names/metadata. Set this on artifact RPC routes,
 * not on every internal endpoint. The decoded byte bound is checked separately on both sides.
 */
export const ATTACHMENT_RPC_MAX_BYTES = 4 * Math.ceil(ATTACHMENT_MAX_BYTES / 3) + 64 * 1024;
const id = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const text = z.string().min(1).max(200);
const base64 = z.string().max(4 * Math.ceil(ATTACHMENT_MAX_BYTES / 3));
export const attachmentSaveRequestSchema = z.object({
  conversationId: text, uploaderId: text, name: z.string().max(4096), mimeType: z.string().max(256), dataBase64: base64,
}).strict();
export const attachmentReadRequestSchema = z.object({ id }).strict();
const savedSchema = z.object({
  id, name: text, mimeType: z.string().min(1).max(256), size: z.number().int().min(0).max(ATTACHMENT_MAX_BYTES),
  kind: z.enum(["image", "text", "file"]), url: z.string().max(2048),
  uploaderId: text, createdAt: z.number().int().nonnegative(), private: z.boolean().optional(),
}).strict();

export function decodeAttachmentBytes(encoded: string): Buffer {
  if (typeof encoded !== "string" || encoded.length > 4 * Math.ceil(ATTACHMENT_MAX_BYTES / 3))
    throw new AttachmentError(413, "Files must be 10 MiB or smaller.");
  const bytes = Buffer.from(encoded, "base64");
  // Buffer's decoder tolerates junk and alternate encodings; RPC accepts canonical base64 only.
  if (bytes.toString("base64") !== encoded) throw new AttachmentError(400, "Invalid attachment encoding.");
  if (bytes.length > ATTACHMENT_MAX_BYTES) throw new AttachmentError(413, "Files must be 10 MiB or smaller.");
  return bytes;
}

/** Worker-side adapter. The callback supplies attempt authentication and bounded network transport.
 * The backend resolves the authoritative route/store namespace and chooses the external download URL.
 * No URLs, S3 credentials, host paths or storage implementation are accepted from an agent/tool.
 * Inherited saveWorkspace snapshots once and calls this.save; imageContent calls this.read.
 */
export class RemoteAttachmentStore extends AttachmentStore {
  constructor(private readonly request: (operation: "save" | "read", input: unknown) => Promise<unknown>) {
    super(""); // No inherited method performs local blob I/O without going through save/read.
  }

  override async save(conversationId: string, uploaderId: string, file: File): Promise<StoredAttachment> {
    if (file.size > ATTACHMENT_MAX_BYTES) throw new AttachmentError(413, "Files must be 10 MiB or smaller.");
    const bytes = Buffer.from(await file.arrayBuffer());
    const input = attachmentSaveRequestSchema.parse({ conversationId, uploaderId, name: file.name, mimeType: file.type, dataBase64: bytes.toString("base64") });
    const record = savedSchema.parse(await this.request("save", input));
    if (record.uploaderId !== uploaderId || record.size !== bytes.length
      || !/^\/api\/chats\/[^/?#]+\/attachments\/[0-9a-f-]+$/.test(record.url) || !record.url.endsWith(`/${record.id}`))
      throw new AttachmentError(502, "Attachment service returned inconsistent metadata.");
    return record;
  }

  override async read(attachment: Attachment): Promise<Buffer> {
    const input = attachmentReadRequestSchema.parse({ id: attachment.id });
    const response = z.object({ dataBase64: base64 }).strict().parse(await this.request("read", input));
    const bytes = decodeAttachmentBytes(response.dataBase64);
    if (bytes.length !== attachment.size) throw new AttachmentError(502, "Attachment service returned inconsistent bytes.");
    return bytes;
  }
}
