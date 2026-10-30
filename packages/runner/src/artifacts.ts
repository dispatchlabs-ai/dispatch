import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, rm } from "node:fs/promises";
import { basename, isAbsolute, join, relative } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineDoc, defineExtension, defineTool, type ConversationId, type ToolExecutionApi, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { privateStateDirectory } from "./private-state.js";

export type Artifact = {
  id: string; name: string; mimeType: string; size: number; sha256: string; createdAt: string;
};
export type ArtifactDelivery = { transport: string; taskId: number; afterResponse?: boolean };
export type ArtifactRecord = Artifact & { deliveries: ArtifactDelivery[] };
/** The host, not model arguments, selects the source account/workspace. */
export type ArtifactSource = (
  path: string, api: ToolExecutionApi, ctx: Context,
) => Promise<{ chunks: AsyncIterable<Uint8Array>; name?: string; mimeType?: string; size?: number; sha256?: string }>;
export type ArtifactSink = (
  tx: Tx, conversationId: ConversationId, artifact: Artifact,
) => Promise<ArtifactDelivery[]>;
export type ArtifactOptions = { source?: ArtifactSource; sink?: ArtifactSink };

const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
export const artifactFilename = (name: string) =>
  basename(name.replaceAll("\\", "/")).replace(/[\x00-\x1f\x7f-\x9f]/g, "_").replace(/^\.+/, "_") || "attachment";
const types: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp",
  gif: "image/gif", svg: "image/svg+xml", txt: "text/plain", md: "text/markdown", csv: "text/csv",
  json: "application/json", zip: "application/zip", html: "text/html",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
export const artifactMimeType = (name: string) => types[name.split(".").at(-1)?.toLowerCase() ?? ""] ?? "application/octet-stream";

/** Immutable bytes are separate from model text; native entries own visibility. */
export class ArtifactStore {
  constructor(readonly directory: string) {}
  output(conversation: number) { return join(this.directory, String(conversation), "outgoing"); }
  private folder(conversation: number) { return join(this.directory, String(conversation), "files"); }
  async prepare(conversation: number) {
    for (const path of [this.directory, join(this.directory, String(conversation)), this.folder(conversation), this.output(conversation)]) {
      await privateStateDirectory(path);
    }
  }
  async local(path: string, conversation: number, workspace?: string) {
    await this.prepare(conversation);
    const resolved = await realpath(path);
    const roots = [await realpath(this.output(conversation)), ...(workspace ? [await realpath(workspace)] : [])];
    if (!isAbsolute(path) || !roots.some(root => {
      const within = relative(root, resolved);
      return !isAbsolute(within) && within !== ".." && !within.startsWith("../");
    })) {
      throw new Error("Use an authorized file inside this conversation's workspace or artifact output directory.");
    }
    const file = await open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && stat.uid !== process.getuid())) {
        throw new Error("Publish an owned regular file, not a link or device.");
      }
    } catch (error) { await file.close(); throw error; }
    return { chunks: file.createReadStream(), name: basename(path) };
  }
  async freeze(conversation: number, source: Awaited<ReturnType<ArtifactSource>>, name: string, mimeType: string): Promise<Artifact> {
    await this.prepare(conversation);
    const temporary = join(this.folder(conversation), `.staging-${randomUUID()}`);
    const handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    const hash = createHash("sha256");
    let size = 0;
    try {
      try {
        for await (const chunk of source.chunks) {
          hash.update(chunk); size += chunk.byteLength;
          await handle.writeFile(chunk);
        }
        await handle.sync();
      } finally { await handle.close(); }
      const sha256 = hash.digest("hex");
      if (source.size !== undefined && size !== source.size || source.sha256 !== undefined && sha256 !== source.sha256) {
        throw new Error("Artifact transfer failed its size/checksum verification; nothing was published.");
      }
      name = artifactFilename(name);
      if (!/^[\w.+-]+\/[\w.+-]+$/.test(mimeType)) throw new Error("Use a MIME type without parameters.");
      const id = digest(`${sha256}\0${name}\0${mimeType}`);
      await rename(temporary, join(this.folder(conversation), id));
      const parent = await open(this.folder(conversation), "r");
      try { await parent.sync(); } finally { await parent.close(); }
      return { id, name, mimeType, size, sha256, createdAt: new Date().toISOString() };
    } finally { await rm(temporary, { force: true }); }
  }
  async read(conversation: number, artifact: Artifact) {
    if (!/^[a-f0-9]{64}$/.test(artifact.id)) throw new Error("Invalid artifact ID.");
    const file = await open(join(this.folder(conversation), artifact.id), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.nlink !== 1 || (process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o077))) {
        throw new Error("Artifact storage must contain private owned regular files.");
      }
      const bytes = await file.readFile();
      if (bytes.length !== artifact.size || digest(bytes) !== artifact.sha256) throw new Error("Retained artifact failed integrity verification.");
      return bytes;
    } finally { await file.close(); }
  }
}

export function createArtifacts(namespace: string) {
  const Artifacts = defineDoc<{ records: Record<string, ArtifactRecord> }>({
    kind: `${namespace}.artifacts`, version: 1, scope: "conversation", history: "latest", fork: "initial",
    initial: () => ({ records: {} }), checkpointWhen: () => false,
  });
  const result = (value: unknown) => ({ output: [{ type: "text" as const, text: JSON.stringify(value) }] });
  // A native child publishes to its owning conversation, not a guessed channel.
  // Independent agents/processes require their host's explicit transfer binding.
  const destination = (api: ToolExecutionApi, ctx: Context) => api.commit(async tx => {
    let id = api.conversationId;
    let record = await tx.conversation(id);
    while (record?.owner) { id = record.owner.conversationId; record = await tx.conversation(id); }
    return id;
  }, ctx);
  function extension(store: ArtifactStore, options: ArtifactOptions = {}) {
    return defineExtension({
      name: `${namespace}.artifacts`,
      sections: [{
        key: "artifacts",
        async render(api) {
          await store.prepare(api.conversationId);
          return `To give the user a document or image, call publish_artifact with its exact file path. ${
            options.source ? "The host transfers files from your assigned workspace; never substitute another workspace."
              : `Use authorized files in your assigned working directory, or create/copy outputs into ${store.output(api.conversationId)} using your granted file tools.`
          } Bytes are retained independently of the workspace. Native children publish to their owning user conversation. A local path or image tool result is not delivery. Publication returns queued transport tasks, not a sent receipt; use artifact_status with wait:true to verify. Do not publish credentials or unrelated files.`;
        },
      }],
      tools: [
        defineTool({
          name: "publish_artifact",
          description: "Retain a document/image from this conversation's authorized workspace and publish it to this conversation's client(s). Binary bytes bypass model context. Same bytes/name/MIME reuse the retained artifact and delivery. A queued task is not proof of sending; check artifact_status.",
          parameters: Type.Object({
            path: Type.String({ minLength: 1 }),
            filename: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            mimeType: Type.Optional(Type.Union([Type.String(), Type.Null()])),
            retryDelivery: Type.Optional(Type.Boolean({ description: "After fixing a failed transport, explicitly retry without changing the retained bytes. Pending or successful deliveries are not duplicated." })),
          }), replay: "safe",
          async execute(args, api, ctx) {
            const target = await destination(api, ctx);
            let artifact = await api.memo<Artifact>("artifact", ctx);
            if (!artifact) {
              const retained = /^artifact:([a-f0-9]{64})$/.exec(args.path);
              if (retained) {
                artifact = (await api.snapshot(Artifacts, target, ctx))?.records[retained[1]];
                if (!artifact) throw new Error("Unknown retained artifact in this conversation.");
              } else {
                const source = await (options.source ? options.source(args.path, api, ctx) : store.local(args.path, api.conversationId, api.env?.cwd));
                const name = args.filename || source.name || basename(args.path);
                artifact = await store.freeze(target, source, name,
                  args.mimeType || ("mimeType" in source && source.mimeType) || artifactMimeType(name));
              }
              artifact = await api.memo("artifact", artifact, ctx);
            }
            await store.read(target, artifact);
            const published = await api.commit(async tx => {
              const state = await tx.doc(Artifacts, target);
              const previous = state.records[artifact!.id];
              if (previous) {
                if (args.retryDelivery) {
                  const tasks = await Promise.all(previous.deliveries.map(delivery =>
                    tx.task(delivery.taskId as import("@earendil-works/pi-durable").TaskId)));
                  if (tasks.every(task => task?.state.status === "terminal"
                    && !(task.state.outcome.status === "completed" && task.state.outcome.result != null))) {
                    previous.deliveries = await options.sink?.(tx, target, previous) ?? [];
                  }
                }
                // Native document overlays expire when this transaction settles.
                return JSON.parse(JSON.stringify(previous)) as ArtifactRecord;
              }
              const record = { ...artifact!, deliveries: await options.sink?.(tx, target, artifact!) ?? [] };
              state.records[record.id] = record;
              await tx.appendEntry(target, { kind: `${namespace}.artifact`, data: record });
              return record;
            }, ctx);
            return result({ artifact: published, path: `artifact:${published.id}`, status: "retained", note: published.deliveries.length
              ? "Transport queued; use artifact_status to verify delivery."
              : "Available through this conversation's artifact download API and local clients." });
          },
        }),
        defineTool({
          name: "artifact_status",
          description: "Inspect retained artifacts and actual transport receipts in this conversation. wait:true waits for delivery except afterResponse:true (email attachments send only after your final response). Failed/aborted tasks are not delivery.",
          parameters: Type.Object({ id: Type.Optional(Type.Union([Type.String(), Type.Null()])), wait: Type.Optional(Type.Boolean()) }),
          replay: "safe",
          async execute(args, api, ctx) {
            const state = await api.snapshot(Artifacts, await destination(api, ctx), ctx);
            const records = args.id ? [state?.records[args.id]] : Object.values(state?.records ?? {});
            if (records.some(record => !record)) throw new Error("Unknown artifact in this conversation.");
            return result(await Promise.all(records.map(async record => ({
              ...record!,
              deliveries: await Promise.all(record!.deliveries.map(async delivery => {
                const id = delivery.taskId as import("@earendil-works/pi-durable").TaskId;
                if (args.wait && !delivery.afterResponse) await api.waitForTask(id, ctx);
                const task = await api.getTask(id, ctx);
                return { ...delivery, status: task?.state.status ?? "missing",
                  delivered: task?.state.status === "terminal" && task.state.outcome.status === "completed" && task.state.outcome.result != null,
                  ...(task?.state.status === "terminal" ? { outcome: task.state.outcome } : {}) };
              })),
            }))));
          },
        }),
      ],
    });
  }
  return { Artifacts, artifactExtension: extension };
}
