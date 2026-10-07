// Opt-in admission probe: real AgentConnections/Pi MCP transport and Pi SQLite;
// credential writes and HTTP/SSE replies are injected doubles, not live OAuth.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { AgentConnections } from "../mcp.js";
import type { McpConnections, ManagedConnectionRecord } from "../mcp-connections.js";
import { WriteAdmission } from "./admission.js";

if (process.env.DISPATCH_MCP_ADMISSION_CHECK !== "disposable") throw new Error("Disposable authorization required.");
const root = await mkdtemp(join(tmpdir(), "dispatch-mcp-admission-"));
const gate = new WriteAdmission(false, async () => {});
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
const waitFor = async (description: string, predicate: () => boolean) => {
  const deadline = Date.now() + 10_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error(`Timed out: ${description}`); await delay(10); }
};
const record: ManagedConnectionRecord = { id: "probe", companyId: "probe-company", ownerId: "probe-human", name: "Admission Probe", endpoint: "https://probe.invalid/mcp", authentication: "oauth", authorization: "authorized", identity: "probe", serverName: "probe", scopes: [], createdAt: 1 };
let tokenCalls = 0;
let unauthorizedCalls = 0;
let recordedCatalogs = 0;
let changedCatalogs = 0;
let getCalls = 0;
let authCompletions = 0;
let blockedCallbacks = 0;
let holdDiscovery = false;
let discoveryEntered = false;
const discoveryRelease = deferred();
let holdToken = false;
let tokenEntered = false;
const tokenRelease = deferred();
let rejectGet = false;
let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
const encoder = new TextEncoder();
const json = (id: unknown, result: unknown) => Response.json({ jsonrpc: "2.0", id, result }, { headers: { "mcp-session-id": "probe-session" } });
const managed = {
  list: () => [record], record: () => record,
  beforeConnect: async () => { assert(!gate.quiesced); },
  recordServer: () => { assert(!gate.quiesced); recordedCatalogs++; },
  authProvider: () => ({
    token: async () => {
      tokenCalls++;
      if (holdToken) { tokenEntered = true; await tokenRelease.promise; }
      assert(!gate.quiesced); authCompletions++;
      return "disposable-token";
    },
    onUnauthorized: async () => { assert(!gate.quiesced); unauthorizedCalls++; },
  }),
  fetch: async (_id: string, _input: string | URL, init?: RequestInit) => {
    if (init?.method === "GET") {
      getCalls++;
      if (rejectGet) return new Response(null, { status: 401 });
      const body = new ReadableStream<Uint8Array>({ start(controller) {
        stream = controller;
        // Accelerate the real transport's reconnect without relying on wall-clock expiry.
        controller.enqueue(encoder.encode("retry: 10\n\n"));
        init.signal?.addEventListener("abort", () => { try { controller.close(); } catch { /* Already closed. */ } }, { once: true });
      } });
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    if (init?.method === "DELETE") return new Response(null, { status: 202 });
    const request = JSON.parse(String(init?.body)) as { id?: unknown; method: string };
    if (request.method === "initialize") return json(request.id, { protocolVersion: "2025-03-26", capabilities: { tools: { listChanged: true } }, serverInfo: { name: "probe", version: "1" } });
    if (request.method === "notifications/initialized") return new Response(null, { status: 202 });
    assert.equal(request.method, "tools/list");
    if (holdDiscovery) { discoveryEntered = true; await discoveryRelease.promise; }
    return json(request.id, { tools: [] });
  },
} satisfies Pick<McpConnections, "list" | "record" | "beforeConnect" | "recordServer" | "authProvider" | "fetch">;
const registry = createRegistry();
const harness = await Harness.open(await openNodeSqliteStorage(join(root, "pi.sqlite")), { models: createModels(), registry }, BACKGROUND_CONTEXT);
const connections = await AgentConnections.load(join(root, "absent-config.json"), registry, managed as unknown as McpConnections, record.companyId);
connections.runBackground = async operation => {
  if (!gate.admitting) blockedCallbacks++;
  return gate.run(operation);
};
connections.onChanged = async () => { assert(!gate.quiesced); changedCatalogs++; };
try {
  await connections.open(harness);
  await waitFor("GET stream", () => getCalls === 1 && stream !== undefined);
  const baseline = recordedCatalogs;
  holdDiscovery = true;
  stream!.enqueue(encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'));
  await waitFor("discovery request in flight", () => discoveryEntered);
  let drained = false;
  const firstDrain = gate.quiesce().then(() => { drained = true; });
  await delay(20); assert(!drained && !gate.quiesced);
  discoveryRelease.resolve();
  await firstDrain;
  assert.equal(recordedCatalogs, baseline + 1);
  assert.equal(changedCatalogs, recordedCatalogs);
  const blockedBefore = blockedCallbacks;
  stream!.enqueue(encoder.encode('data: {"jsonrpc":"2.0","method":"notifications/tools/list_changed"}\n\n'));
  await waitFor("late discovery denied", () => blockedCallbacks > blockedBefore);
  assert.equal(recordedCatalogs, baseline + 1);
  await gate.resume();
  holdToken = true;
  stream!.close();
  await waitFor("SSE reconnect credential resolution", () => tokenEntered);
  drained = false;
  const secondDrain = gate.quiesce().then(() => { drained = true; });
  await delay(20); assert(!drained && !gate.quiesced);
  rejectGet = true;
  const priorBlocked = blockedCallbacks;
  tokenRelease.resolve();
  await secondDrain;
  await waitFor("late unauthorized callback denied", () => blockedCallbacks > priorBlocked);
  assert(gate.quiesced);
  assert.equal(unauthorizedCalls, 0);
  const callsAtDrain = tokenCalls;
  const completionsAtDrain = authCompletions;
  const blockedAtDrain = blockedCallbacks;
  await connections.close();
  assert(blockedCallbacks > blockedAtDrain); // Transport DELETE tried resolving auth, but admission rejected it.
  assert.equal(tokenCalls, callsAtDrain);
  assert.equal(authCompletions, completionsAtDrain);
  assert.equal(recordedCatalogs, baseline + 1);
  console.log(JSON.stringify({ scope: "real Pi MCP 1.0.4 transport and AgentConnections, injected credential/HTTP doubles, disposable Pi SQLite; not live OAuth or deployed backup qualification", passed: [
    "Drain waits for notification discovery and ensuing catalog writes/callbacks",
    "Late list-change notification is denied without catalog writes",
    "Drain waits for credential resolution begun by independent SSE reconnect",
    "Late 401 cannot enter the credential-mutating unauthorized callback after drain",
    "Transport close cannot renew credentials after quiescence",
  ], tokenCalls, authCompletions, unauthorizedCalls, recordedCatalogs, changedCatalogs, blockedCallbacks }, null, 2));
} finally {
  discoveryRelease.resolve(); tokenRelease.resolve();
  await connections.close(); await harness.close(BACKGROUND_CONTEXT);
  await rm(root, { recursive: true, force: true });
}
