// Opt-in S3 adapter probe. Without a config file it uses a disposable loopback HTTP double.
// DISPATCH_S3_PROBE_CONFIG_FILE selects an explicitly disposable real S3 bucket/prefix instead.
// Real mode retains its two random-store objects for independent inspection; it never deletes data.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S3Artifacts, s3ArtifactsConfigSchema } from "./s3-artifacts.js";
import { ATTACHMENT_MAX_BYTES } from "../../src/shared/contracts.js";

if (process.env.DISPATCH_S3_PROBE_ALLOW !== "disposable") throw new Error("Explicit disposable authorization required.");
const filename = process.env.DISPATCH_S3_PROBE_CONFIG_FILE;
const root = await mkdtemp(join(tmpdir(), "dispatch-s3-check-"));
const objects = new Map<string, Buffer>();
let rejectWrites = false;
let writes = 0;
let signatureSeen = false;
let conditionalSeen = false;
const server = createServer(async (request, response) => {
  const path = new URL(request.url!, "http://127.0.0.1").pathname;
  signatureSeen ||= request.headers.authorization?.startsWith("AWS4-HMAC-SHA256 ") ?? false;
  if (request.method === "PUT") {
    writes++;
    conditionalSeen ||= request.headers["if-none-match"] === "*";
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    if (rejectWrites) { response.writeHead(503); response.end("<Error><Code>ServiceUnavailable</Code></Error>"); return; }
    if (objects.has(path)) { response.writeHead(412); response.end(); return; }
    objects.set(path, Buffer.concat(chunks)); response.writeHead(200); response.end(); return;
  }
  const bytes = objects.get(path);
  if (!bytes) { response.writeHead(404); response.end("<Error><Code>NoSuchKey</Code></Error>"); return; }
  response.writeHead(200, { "Content-Length": bytes.length }); response.end(bytes);
});
let client: S3Artifacts | undefined;
try {
  let config;
  if (filename) config = s3ArtifactsConfigSchema.parse(JSON.parse(await readFile(filename, "utf8")));
  else {
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No loopback listener.");
    const credentialsFile = join(root, "credentials.json");
    await writeFile(credentialsFile, JSON.stringify({ accessKeyId: "disposable-probe", secretAccessKey: randomUUID() }), { mode: 0o600 });
    config = s3ArtifactsConfigSchema.parse({ endpoint: `http://127.0.0.1:${address.port}`, region: "garage", bucket: "disposable-probe", prefix: "qualification/", credentialsFile });
  }
  const storeId = `qualification:${randomUUID()}`;
  const conversationId = `external:${randomUUID()}`;
  const marker = `artifact:${randomUUID()}`;
  client = await S3Artifacts.open(config);
  const file = await client.save(storeId, conversationId, "probe-user", new File([marker], "retained.txt", { type: "text/plain" }));
  assert.equal(file.kind, "text");
  assert.equal(file.url, `/api/chats/${encodeURIComponent(conversationId)}/attachments/${file.id}`);
  assert.equal((await client.read(storeId, file.id)).toString(), marker);
  await assert.rejects(client.read(`other:${randomUUID()}`, file.id), /not found/);
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==", "base64");
  const image = await client.save(storeId, conversationId, "probe-user", new File([png], "probe.png", { type: "image/png" }));
  assert.equal(image.kind, "image");
  assert.deepEqual(await client.read(storeId, image.id), png);
  await assert.rejects(client.save(storeId, conversationId, "probe-user", new File(["not an image"], "bad.png", { type: "image/png" })), /declared type/);
  await assert.rejects(client.save(storeId, conversationId, "probe-user", new File([new Uint8Array(ATTACHMENT_MAX_BYTES + 1)], "large")), /10 MiB/);
  client.close();
  client = await S3Artifacts.open(config);
  assert.equal((await client.read(storeId, file.id)).toString(), marker);
  const passed = ["SDK PUT/GET retains text/image bytes and external-chat URL", "store namespace rejects cross-store artifact lookup", "native MIME and size validation retained", "new client retrieves existing bytes"];
  if (!filename) {
    assert(signatureSeen); assert(conditionalSeen); assert.equal(writes, 2);
    rejectWrites = true;
    await assert.rejects(client.save(storeId, conversationId, "probe-user", new File(["uncertain"], "failure.txt")), /outcome may be uncertain/);
    assert.equal(writes, 3); // SDK must not silently retry a failed mutation.
    const key = `/disposable-probe/qualification/${createHash("sha256").update(storeId).digest("hex")}/${file.id}`;
    assert(objects.has(key));
    objects.set(key, Buffer.alloc(ATTACHMENT_MAX_BYTES + 1));
    await assert.rejects(client.read(storeId, file.id), /byte limit/);
    await chmod(config.credentialsFile!, 0o644);
    await assert.rejects(S3Artifacts.open(config), /restricted regular file/);
    passed.push("AWS4 signing, conditional PUT, explicit single attempt, read byte bound and private credentials checked against HTTP double");
  }
  console.log(JSON.stringify({ scope: filename ? "actual configured S3 service; no worker/RPC/backup qualification" : "AWS SDK against loopback HTTP double; no actual S3 service", storeId, artifacts: [file, image].map(item => ({ id: item.id, url: item.url })), passed }, null, 2));
} finally {
  client?.close();
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
}
