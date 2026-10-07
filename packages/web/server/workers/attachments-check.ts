// Explicit disposable check of the worker attachment adapter; no HTTP or S3 service is contacted.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AttachmentStore, type StoredAttachment } from "../attachments.js";
import { ATTACHMENT_MAX_BYTES } from "../../src/shared/contracts.js";
import { RemoteAttachmentStore, attachmentSaveRequestSchema, attachmentReadRequestSchema, decodeAttachmentBytes } from "./attachments.js";

if (process.env.DISPATCH_ATTACHMENT_CHECK !== "disposable") throw new Error("Explicit disposable authorization required.");
const root = await mkdtemp(join(tmpdir(), "dispatch-remote-attachments-"));
try {
  const backend = new AttachmentStore(join(root, "backend-only"));
  const records = new Map<string, StoredAttachment>();
  const rpc = async (operation: "save" | "read", input: unknown) => {
    if (operation === "save") {
      const data = attachmentSaveRequestSchema.parse(input);
      const bytes = decodeAttachmentBytes(data.dataBase64);
      const record = await backend.save("external-route", data.uploaderId, new File([new Uint8Array(bytes)], data.name, { type: data.mimeType }));
      records.set(record.id, record);
      return record;
    }
    const { id } = attachmentReadRequestSchema.parse(input);
    const record = records.get(id);
    if (!record) throw new Error("Not found in this route");
    return { dataBase64: (await backend.read(record)).toString("base64") };
  };
  let remote = new RemoteAttachmentStore(rpc);
  const text = await remote.save("local-room-1", "human", new File(["retained text"], "probe.txt", { type: "text/plain" }));
  assert.equal(text.url, `/api/chats/external-route/attachments/${text.id}`);
  assert.equal((await remote.read(text)).toString(), "retained text");
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  await writeFile(join(workspace, "draft.txt"), "snapshot before change");
  const privateFile = await remote.saveWorkspace("local-room-1", "agent", workspace, "draft.txt");
  assert.equal(privateFile.private, true);
  await writeFile(join(workspace, "draft.txt"), "changed source");
  assert.equal((await remote.read(privateFile)).toString(), "snapshot before change");
  await rm(workspace, { recursive: true });
  remote = new RemoteAttachmentStore(rpc);
  assert.equal((await remote.read(privateFile)).toString(), "snapshot before change");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const image = await remote.save("local-room-1", "human", new File([png], "probe.png", { type: "image/png" }));
  const content = await remote.imageContent([image]);
  assert.equal(content[0].type, "image");
  if (content[0].type === "image") assert.equal(content[0].data, png.toString("base64"));
  await assert.rejects(remote.save("local-room-1", "human", new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], "large")), /10 MiB/);
  assert.throws(() => decodeAttachmentBytes("%%%"), /encoding/);
  assert.throws(() => decodeAttachmentBytes("YQ"), /encoding/);
  assert.equal(decodeAttachmentBytes("").length, 0);
  const unavailable = new RemoteAttachmentStore(async () => { throw new Error("injected transport unavailable"); });
  await assert.rejects(unavailable.read(text), /transport unavailable/);
  const inconsistent = new RemoteAttachmentStore(async () => ({ dataBase64: Buffer.from("short").toString("base64") }));
  await assert.rejects(inconsistent.read(text), /inconsistent bytes/);
  console.log(JSON.stringify({ scope: "remote attachment adapter with injected backend; no HTTP/S3", passed: [
    "save/read preserve bytes and external route URL", "workspace helper snapshots once and preserves private metadata", "fresh adapter retrieves bytes after workspace deletion", "inherited image helper uses remote bytes", "size, base64, response-length and transport failures reject without local fallback",
  ] }, null, 2));
} finally { await rm(root, { recursive: true, force: true }); }
