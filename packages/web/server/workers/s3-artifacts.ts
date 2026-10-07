import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { z } from "zod";
import { AttachmentError, prepareAttachment, type StoredAttachment } from "../attachments.js";
import { ATTACHMENT_MAX_BYTES } from "../../src/shared/contracts.js";
import { attachmentReadRequestSchema } from "./attachments.js";

export const s3ArtifactsConfigSchema = z.object({
  endpoint: z.url().refine(value => { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; }),
  region: z.string().min(1).max(100), bucket: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/),
  prefix: z.string().min(1).max(512).refine(value => /^[a-zA-Z0-9._/-]+$/.test(value) && value.replace(/\/$/, "").split("/").every(segment => segment && segment !== "." && segment !== "..")),
  credentialsFile: z.string().min(1),
}).strict();
export type S3ArtifactsConfig = z.infer<typeof s3ArtifactsConfigSchema>;
const credentialsSchema = z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), sessionToken: z.string().min(1).optional() }).strict();
const identity = z.string().min(1).max(200);

/** Backend-only S3 adapter. Pi owns attachment metadata/publication; S3 owns immutable blob bytes.
 * Never accept a worker-selected bucket, prefix, URL or store: callers supply the authenticated route.
 * There is no bucket provisioning, local fallback, delete, overwrite or transparent mutation retry.
 */
export class S3Artifacts {
  private constructor(private readonly config: S3ArtifactsConfig, private readonly client: S3Client) {}

  static async open(input: S3ArtifactsConfig): Promise<S3Artifacts> {
    const config = s3ArtifactsConfigSchema.parse(input);
    const file = await open(config.credentialsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    let credentials: z.infer<typeof credentialsSchema>;
    try {
      const info = await file.stat();
      if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) throw new Error("Artifact credentials must be a restricted regular file.");
      try { credentials = credentialsSchema.parse(JSON.parse(await file.readFile("utf8"))); }
      catch { throw new Error("Invalid artifact credential file."); }
    } finally { await file.close(); }
    return new S3Artifacts(config, new S3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: true, credentials, maxAttempts: 1,
      // Ordinary PutObject payloads support S3-compatible servers without optional AWS checksum trailers.
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    }));
  }

  async save(storeId: string, conversationId: string, uploaderId: string, file: File): Promise<StoredAttachment> {
    identity.parse(conversationId); identity.parse(uploaderId);
    const { record, bytes } = await prepareAttachment(conversationId, uploaderId, file);
    const Key = this.key(storeId, record.id);
    try {
      await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key, Body: bytes, ContentType: record.mimeType, ContentLength: bytes.length, IfNoneMatch: "*" }), { abortSignal: AbortSignal.timeout(60_000) });
    } catch { throw new AttachmentError(503, "Artifact publication failed; outcome may be uncertain."); }
    return record;
  }

  async read(storeId: string, attachmentId: string): Promise<Buffer> {
    const Key = this.key(storeId, attachmentId);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key }), { abortSignal: AbortSignal.timeout(60_000) });
      const stream = result.Body as Readable | undefined; // Node HTTP handler supplies a Readable.
      if (!stream) throw new AttachmentError(502, "Artifact service returned no bytes.");
      try {
        if (result.ContentLength !== undefined && result.ContentLength > ATTACHMENT_MAX_BYTES) throw new AttachmentError(502, "Artifact exceeds the byte limit.");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > ATTACHMENT_MAX_BYTES) throw new AttachmentError(502, "Artifact exceeds the byte limit.");
          chunks.push(bytes);
        }
        if (result.ContentLength !== undefined && size !== result.ContentLength) throw new AttachmentError(502, "Artifact service returned incomplete bytes.");
        return Buffer.concat(chunks, size);
      } finally { stream.destroy(); }
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404) throw new AttachmentError(404, "Attachment not found.");
      throw new AttachmentError(503, "Artifact bytes are unavailable.");
    }
  }

  close(): void { this.client.destroy(); }

  private key(storeId: string, attachmentId: string): string {
    identity.parse(storeId);
    attachmentReadRequestSchema.parse({ id: attachmentId });
    const store = createHash("sha256").update(storeId).digest("hex");
    return `${this.config.prefix.replace(/\/$/, "")}/${store}/${attachmentId}`;
  }
}
