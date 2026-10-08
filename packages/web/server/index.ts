import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { createAuth } from "./auth.js";
import { createApp } from "./app.js";
import { readConfig } from "./config.js";
import { openModels } from "./model-auth.js";
import { DEFAULT_AGENT_ID, DispatchRuntime } from "./runtime.js";
import { McpConnections } from "./mcp-connections.js";

const config = readConfig();
await mkdir(config.stateDir, { recursive: true, mode: 0o700 });
const provider = await openModels();
const auth = await createAuth({
  databasePath: join(config.stateDir, "auth.sqlite"), secretPath: join(config.stateDir, "auth.key"),
  origin: config.origin, rpId: config.rpId, companyId: config.companyId, companyName: config.companyName,
});
const mcpConnections = new McpConnections(join(config.stateDir, "connections.sqlite"), join(config.stateDir, "connections.key"), config.origin);
const runtime = await DispatchRuntime.open({
  stateDir: join(config.stateDir, "runtime"), companyId: config.companyId, models: provider.models,
  readAllProjectUserIds: config.readAllProjectUserIds,
  piStorage: config.piStorage,
  connectionsFile: config.connectionsFile, workspaceDir: config.workspaceDir,
  mcpConnections,
  provider: provider.provider, modelId: provider.modelId, thinkingLevel: provider.thinkingLevel,
  peopleDirectory: {
    list: async (companyId) => auth.listCompanyPeople(companyId),
    get: async (companyId, userId) => auth.getCompanyPerson(companyId, userId),
  },
}).catch(async error => { await mcpConnections.close(); await auth.close(); throw error; });
const clientDir = process.env.DISPATCH_CLIENT_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../client");
const app = createApp({
  auth, runtime, mcpConnections, origin: config.origin,
  clientDir: process.env.DISPATCH_SERVE_CLIENT === "false" ? undefined : clientDir,
  configuration: async () => ({
    company: { id: config.companyId, name: config.companyName }, defaultAgentId: DEFAULT_AGENT_ID, ...await provider.configuration(await runtime.getDefaultAgent(config.companyId)),
  }),
});
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, () => {
  console.log(`Dispatch service listening on ${config.host}:${config.port}; application origin ${config.origin}`);
});
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  await runtime.close();
  // This process owns one runtime; release all provider caches after its work drains.
  cleanupSessionResources();
  await mcpConnections.close();
  await auth.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
}
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
