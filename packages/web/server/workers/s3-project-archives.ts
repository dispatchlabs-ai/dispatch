import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { Readable } from "node:stream";
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fromHttp } from "@aws-sdk/credential-provider-http";
import { z } from "zod";
import { PROJECT_ARCHIVE_MAX_BYTES, type ProjectArchive } from "../../src/shared/project-archives.js";
import { archiveDigest, decodeProjectArchive, ProjectArchiveError, type ArchiveBlob, type ProjectArchiveStorage } from "../project-archives.js";
import { s3ArtifactsConfigSchema, type S3ArtifactsConfig } from "./s3-artifacts.js";

const credentialsSchema = z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1), sessionToken: z.string().min(1).optional() }).strict();
const referenceSchema = z.object({ id: z.uuid(), digest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();

/** Backend-only immutable archives under the configured artifact prefix.
 * The caller authorizes the project, awaits save before committing its pointer,
 * and joins admitted operations before close. No local fallback or mutation retry.
 */
export class S3ProjectArchiveStore implements ProjectArchiveStorage {
  private closed = false;
  private constructor(private readonly config: S3ArtifactsConfig, private readonly prefix: string, private readonly client: S3Client) {}

  static async open(input: S3ArtifactsConfig, installationId: string): Promise<S3ProjectArchiveStore> {
    const config = s3ArtifactsConfigSchema.parse(input);
    if (!installationId || installationId.length > 200) throw new Error("Archive storage requires an installation identity.");
    let credentials: z.infer<typeof credentialsSchema> | undefined;
    if (config.credentialsFile) {
      try {
        const file = await open(config.credentialsFile, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          const info = await file.stat();
          if (!info.isFile() || (info.mode & 0o077) !== 0 || info.size > 16 * 1024) throw new Error("Invalid credential file.");
          credentials = credentialsSchema.parse(JSON.parse(await file.readFile("utf8")));
        } finally { await file.close(); }
      } catch { throw new Error("Archive credentials require a valid restricted regular file."); }
    }
    const prefix = `${config.prefix.replace(/\/$/, "")}/project-archives/${archiveDigest(installationId)}`;
    return new S3ProjectArchiveStore(config, prefix, new S3Client({
      endpoint: config.endpoint, region: config.region, forcePathStyle: true,
      credentials: config.taskRole ? fromHttp() : credentials, maxAttempts: 1,
      requestChecksumCalculation: "WHEN_REQUIRED", responseChecksumValidation: "WHEN_REQUIRED",
    }));
  }

  async save(archive: ProjectArchive): Promise<ArchiveBlob> {
    this.requireOpen();
    // Snapshot and validate before any asynchronous work or object publication.
    const text = JSON.stringify(archive);
    decodeProjectArchive(text);
    const bytes = Buffer.from(text);
    const blob = { id: randomUUID(), digest: archiveDigest(bytes) };
    try {
      await this.client.send(new PutObjectCommand({
        Bucket: this.config.bucket, Key: `${this.prefix}/${blob.id}`, Body: bytes,
        ContentType: "application/json", ContentLength: bytes.length, IfNoneMatch: "*",
      }), { abortSignal: AbortSignal.timeout(60_000) });
    } catch { throw new ProjectArchiveError(503, "Archive publication failed; outcome may be uncertain."); }
    return blob;
  }

  async read(blob: ArchiveBlob): Promise<ProjectArchive> {
    this.requireOpen();
    const parsed = referenceSchema.safeParse(blob);
    if (!parsed.success) throw new ProjectArchiveError(410, "Invalid stored archive reference.");
    const reference = parsed.data;
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: `${this.prefix}/${reference.id}` }),
        { abortSignal: AbortSignal.timeout(60_000) });
      const stream = result.Body as Readable | undefined; // Node HTTP handler supplies a Readable.
      if (!stream) throw new ProjectArchiveError(410, "Stored archive is unavailable.");
      try {
        if (result.ContentLength !== undefined && (!Number.isSafeInteger(result.ContentLength) || result.ContentLength < 0 || result.ContentLength > PROJECT_ARCHIVE_MAX_BYTES))
          throw new ProjectArchiveError(410, "Stored archive exceeds the byte limit.");
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.from(chunk);
          size += bytes.length;
          if (size > PROJECT_ARCHIVE_MAX_BYTES) throw new ProjectArchiveError(410, "Stored archive exceeds the byte limit.");
          chunks.push(bytes);
        }
        if (result.ContentLength !== undefined && size !== result.ContentLength) throw new ProjectArchiveError(410, "Stored archive is incomplete.");
        const bytes = Buffer.concat(chunks, size);
        if (archiveDigest(bytes) !== reference.digest) throw new ProjectArchiveError(410, "Stored archive integrity check failed.");
        try { return decodeProjectArchive(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
        catch { throw new ProjectArchiveError(410, "Stored archive content is invalid."); }
      } finally { stream.destroy(); }
    } catch (error) {
      if (error instanceof ProjectArchiveError) throw error;
      if ((error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 404)
        throw new ProjectArchiveError(410, "Stored archive is unavailable.");
      throw new ProjectArchiveError(503, "Stored archive bytes are unavailable.");
    }
  }

  close(): void { this.closed = true; this.client.destroy(); }

  private requireOpen() {
    if (this.closed) throw new ProjectArchiveError(503, "Archive storage is closed.");
  }
}
