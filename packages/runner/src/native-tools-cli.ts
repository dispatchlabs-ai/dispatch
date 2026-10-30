#!/usr/bin/env node
import { createServer } from "node:http";
import { chmod, mkdir, rm } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { openNativeTools } from "./native-tools.js";

const { values } = parseArgs({ options: {
  state: { type: "string" }, workspace: { type: "string" }, socket: { type: "string" },
  "cancel-pending": { type: "boolean" },
} });
if (!values.state || !values.workspace || !values.socket) throw new Error("Supply --state, --workspace and --socket.");
const socket = resolve(values.socket);
await mkdir(values.workspace, { recursive: true, mode: 0o700 });
const native = await openNativeTools(resolve(values.state), resolve(values.workspace));
if (values["cancel-pending"]) await native.stop();
await rm(socket, { force: true });
const server = createServer(async (request, response) => {
  try {
    if (request.method !== "POST" || request.url !== "/commands") throw new Error("Unknown endpoint.");
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    const command = JSON.parse(Buffer.concat(chunks).toString());
    const result = command.tool === "coding" ? await native.execute({ ...command.arguments, requestId: command.requestId })
      : command.tool === "status" ? await native.status()
      : command.tool === "stop" ? (await native.stop(), await native.status())
      : (() => { throw new Error("Unknown native tool command."); })();
    response.end(JSON.stringify({ ok: true, result }));
  } catch (error) {
    response.statusCode = 400;
    response.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Native execution failed." }));
  }
});
await new Promise<void>(done => server.listen(socket, done));
await chmod(socket, 0o600);
console.log(JSON.stringify({ ready: true, pid: process.pid }));
let closing: Promise<void> | undefined;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  closing ??= (async () => { server.close(); await native.close(); process.exit(0); })();
  void closing;
});
