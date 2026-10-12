import { ProviderSetupError, type ProviderSetup } from "./provider-setup.js";
import { activityPage, HistoryCursorError } from "./chat-pages.js";
import { chatDelta } from "../src/shared/chat-updates.js";
import { decodeProjectArchive, projectArchivePreview, ProjectArchiveError } from "./project-archives.js";
import { createDeveloperStarter } from "./starters.js";
import { fetchGithubBundle, githubSourceSchema } from "./github-bundles.js";
import { BUNDLE_MAX_BYTES, BundleError, bundleExportSchema, decodeBundle, encodeBundle } from "./bundles.js";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { createAuth, AuthPrincipal } from "./auth.js";
import { projectRepositoriesSchema, projectSpecSchema } from "../src/shared/project-sources.js";
import { ProjectAccessError } from "./project-access.js";
import { ProjectSpecError } from "./project-spec.js";
import { RuntimeError } from "./runtime.js";
import type { RuntimeService } from "./runtime-service.js";
import { CollaborationError } from "./collaboration/shared.js";
import type { ApplicationConfig, ChatSnapshot } from "../src/shared/contracts.js";
import { ConnectionError, type McpConnections } from "./mcp-connections.js";
import { AttachmentError, readAttachmentUpload } from "./attachments.js";
import { ATTACHMENT_MAX_COUNT } from "../src/shared/contracts.js";
import { EvaluationError, parseEvaluationRevision } from "./evaluations.js";
import { ManagementError } from "./agent-grants.js";
import { randomToken } from "./auth/crypto.js";

type Auth = Awaited<ReturnType<typeof createAuth>>;
type AppOptions = {
  auth: Auth;
  runtime: RuntimeService;
  mcpConnections: McpConnections;
  origin: string;
  providerSetup?: ProviderSetup;
  configuration: () => Promise<ApplicationConfig>;
  clientDir?: string;
};
const requestId = z.string().trim().min(1).max(200);
const identity = z.string().min(1).max(200);
const identities = z.array(identity).refine(values => new Set(values).size === values.length, "Choose each participant once.");
const agentSchema = z.object({
  id: z.string().min(1).max(200).optional(), expectedRevision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100), description: z.string().max(500), instructions: z.string().max(50_000),
  executionBackend: z.enum(["pi", "claude-agent-sdk"]).optional(),
  provider: z.string().min(1).max(100), modelId: z.string().min(1).max(200),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  capabilities: z.array(z.enum(["files-and-commands", "image-generation", "web-reading", "web-search", "edit-definition-of-done"])).max(5).optional(),
  skills: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict()).max(50).refine(values => new Set(values.map(value => value.id)).size === values.length).optional(),
  connectionIds: z.array(z.string().uuid()).refine(values => new Set(values).size === values.length).optional(),
  applyConnectionsToExisting: z.boolean().optional(), requestId: requestId.optional(),
}).strict();
const connectionBase = {
  requestId, name: z.string().trim().min(1).max(100), endpoint: z.url().max(2048), connectionId: z.string().uuid().optional(),
};
const credentialValue = z.string().min(1).max(16_384).refine(value => !/[\r\n]/.test(value), "Credentials cannot contain newlines.");
const customHeaders = z.record(z.string().regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/), credentialValue)
  .refine(headers => Object.keys(headers).length > 0, "Add an authentication header.")
  .refine(headers => {
    const names = Object.keys(headers).map(name => name.toLowerCase());
    return new Set(names).size === names.length && names.every(name => !["host", "connection", "content-length", "transfer-encoding", "accept", "content-type", "mcp-session-id", "mcp-protocol-version", "last-event-id"].includes(name));
  }, "Use unique authentication headers; transport and MCP session headers are managed by Dispatch.");
const connectionSchema = z.preprocess(value => {
  // Keep in-progress clients from the previous editor compatible during rollout.
  if (value && typeof value === "object" && !("authentication" in value)) return { ...value, authentication: "oauth" };
  return value;
}, z.discriminatedUnion("authentication", [
  z.object({ ...connectionBase, authentication: z.literal("oauth"),
    scopes: z.array(z.string().min(1).max(1000).regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/)).optional(),
    clientId: z.string().trim().min(1).max(2048).optional(), clientSecret: credentialValue.optional() }).strict(),
  z.object({ ...connectionBase, authentication: z.literal("bearer"), token: credentialValue }).strict(),
  z.object({ ...connectionBase, authentication: z.literal("headers"), headers: customHeaders }).strict(),
  z.object({ ...connectionBase, authentication: z.literal("none") }).strict(),
]));

export function createApp(options: AppOptions) {
  const { auth, runtime } = options;
  const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    await next();
  });
  // Commit a same-origin document before sending the callback with the existing
  // Strict session cookie. Cross-site OAuth navigation must not weaken that cookie.
  app.get("/api/connections/oauth/callback", c => {
    const nonce = randomToken();
    c.header("Cache-Control", "no-store");
    c.header("Content-Security-Policy", `default-src 'none'; connect-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`);
    return c.html(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MCP connection · Dispatch</title><style nonce="${nonce}">body{font:16px system-ui;color:#10243f;max-width:34rem;margin:12vh auto;padding:2rem;line-height:1.6}a{color:#1d3d6a}button{font:inherit;padding:.6rem 1rem}</style><h1 id="heading">Connecting your server</h1><p id="message" role="status">Confirming authorization…</p><p><a href="/?section=connections" target="_blank" rel="noopener">Open Dispatch</a></p><button id="retry" disabled>Try again</button><script nonce="${nonce}">
      const response=location.search.slice(1);
      history.replaceState(null,"","/api/connections/oauth/callback");
      const button=document.getElementById("retry");
      async function complete(){
        button.disabled=true;
        try{
          const reply=await fetch("/api/connections/oauth/complete",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify({response})});
          const result=await reply.json();
          if(!reply.ok)throw new Error(result.error?.message||"Authorization could not be confirmed.");
          document.getElementById("heading").textContent=result.authorized?"Connection authorized":"Connection needs attention";
          document.getElementById("message").textContent=result.message;
          button.hidden=result.authorized;
          if(window.opener){window.opener.postMessage({type:"dispatch-mcp-authorized"},${JSON.stringify(options.origin)});if(result.authorized)window.close();}
        }catch(error){document.getElementById("heading").textContent="Connection needs attention";document.getElementById("message").textContent=error.message+" Open Dispatch to sign in if needed, then try again here.";}
        finally{button.disabled=false;}
      }
      button.addEventListener("click",complete);void complete();
    </script></html>`);
  });
  const jsonLimit = bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: { code: "too_large", message: "Request is too large." } }, 413) });
  const bundleLimit = bodyLimit({ maxSize: 12 * 1024 * 1024, onError: c => c.json({ error: { code: "too_large", message: "Bundle request is too large." } }, 413) });
  const projectArchiveLimit = bodyLimit({ maxSize: 64 * 1024 * 1024 + 1024, onError: c => c.json({ error: { code: "too_large", message: "Project archive request is too large." } }, 413) });
  // JSON escaping can expand a 512 KiB text file up to sixfold.
  const specLimit = bodyLimit({ maxSize: 6 * 512 * 1024 + 1024, onError: c => c.json({ error: { code: "too_large", message: "Spec request is too large." } }, 413) });
  const instructionsLimit = bodyLimit({ maxSize: 6 * 50_000 + 1024, onError: c => c.json({ error: { code: "too_large", message: "Instructions request is too large." } }, 413) });
  const isUpload = (method: string, path: string) => method === "POST" && /^\/api\/chats\/[^/]+\/attachments$/.test(path);
  // Upload bytes are counted only after authentication and conversation authorization below.
  app.use("/api/*", (c, next) => isUpload(c.req.method, c.req.path) ? next() : /^\/api\/project-archives\/(preview|import)$/.test(c.req.path) ? projectArchiveLimit(c, next) : /^\/api\/bundles\/(preview|import)$/.test(c.req.path) ? bundleLimit(c, next) : c.req.method === "POST" && /^\/api\/projects\/[^/]+\/spec$/.test(c.req.path) ? specLimit(c, next) : c.req.method === "POST" && /^\/api\/projects\/[^/]+\/instructions$/.test(c.req.path) ? instructionsLimit(c, next) : jsonLimit(c, next));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(c.req.method)) {
      if (c.req.header("origin") !== options.origin) return c.json({ error: { code: "origin", message: "Request origin is not allowed." } }, 403);
      const type = isUpload(c.req.method, c.req.path) ? "multipart/form-data" : "application/json";
      if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== type) return c.json({ error: { code: "content_type", message: `Use a ${type} request.` } }, 415);
    }
    const response = await auth.handle(c.req.raw);
    if (response) return response;
    const principal = await auth.authenticate(c.req.raw);
    if (!principal) return c.json({ error: { code: "unauthenticated", message: "Sign in to continue." } }, 401);
    c.set("principal", principal);
    await next();
  });
  const providerId = z.enum(["openai", "openai-codex", "anthropic", "fireworks"]);
  const providerSetup = () => {
    if (!options.providerSetup) throw new ProviderSetupError(503, "Provider setup is not configured on this installation.");
    return options.providerSetup;
  };
  app.get("/api/model-providers", c => providerSetup().list(c.get("principal")).then(value => c.json(value)));
  app.post("/api/model-providers/:providerId/connect", async c => {
    const input = z.object({ type: z.enum(["oauth", "api_key"]), revision: z.string().min(1).max(200) }).strict().parse(await c.req.json());
    return c.json(await providerSetup().start(c.get("principal"), providerId.parse(c.req.param("providerId")), input.type, input.revision));
  });
  app.post("/api/model-providers/:providerId/disconnect", async c => {
    const input = z.object({ revision: z.string().min(1).max(200) }).strict().parse(await c.req.json());
    return c.json(await providerSetup().disconnect(providerId.parse(c.req.param("providerId")), input.revision));
  });
  app.get("/api/model-providers/attempts/:id", async c => c.json(await providerSetup().get(c.get("principal"), c.req.param("id"))));
  app.post("/api/model-providers/attempts/:id/answer", async c => {
    const input = z.object({ promptId: z.string().uuid(), value: z.string().min(1).max(16384) }).strict().parse(await c.req.json());
    return c.json(providerSetup().answer(c.get("principal"), c.req.param("id"), input.promptId, input.value));
  });
  app.post("/api/model-providers/attempts/:id/cancel", async c => {
    z.object({}).strict().parse(await c.req.json());
    return c.json(await providerSetup().cancel(c.get("principal"), c.req.param("id")));
  });
  app.get("/api/config", async (c) => c.json(await options.configuration()));
  app.get("/api/secrets/exa", async c => c.json(await options.mcpConnections.searchSecret(c.get("principal"))));
  app.post("/api/secrets/exa", async c => {
    const input = z.object({ revision: z.number().int().nonnegative(), source: z.enum(["stored", "environment"]), value: z.string().trim().min(1).optional(), agentIds: z.array(z.string().min(1)) }).strict().parse(await c.req.json());
    const scope = c.get("principal");
    const agents = await runtime.listAgents(scope);
    if (input.agentIds.some(id => !agents.some(agent => agent.id === id && !agent.archived))) throw new ConnectionError(400, "Choose current agents from this workspace.");
    return c.json(await options.mcpConnections.saveSearchSecret(scope, input));
  });
  app.post("/api/secrets/exa/disconnect", async c => {
    const input = z.object({ revision: z.number().int().nonnegative() }).strict().parse(await c.req.json());
    return c.json(await options.mcpConnections.disconnectSearchSecret(c.get("principal"), input.revision));
  });
  app.get("/api/secrets", async c => c.json({ secrets: await options.mcpConnections.namedSecrets(c.get("principal")) }));
  const namedSecretSchema = z.object({ name: z.string().trim().min(1).max(100), value: z.string().min(1).max(16384).optional(), revision: z.number().int().nonnegative() }).strict();
  app.post("/api/secrets", async c => c.json(await options.mcpConnections.saveNamedSecret(c.get("principal"), undefined, namedSecretSchema.parse(await c.req.json()))));
  app.post("/api/secrets/:id", async c => c.json(await options.mcpConnections.saveNamedSecret(c.get("principal"), c.req.param("id"), namedSecretSchema.parse(await c.req.json()))));
  app.post("/api/secrets/:id/delete", async c => {
    const input = z.object({ revision: z.number().int().nonnegative() }).strict().parse(await c.req.json());
    await options.mcpConnections.deleteNamedSecret(c.get("principal"), c.req.param("id"), input.revision);
    return c.json({ deleted: true });
  });
  app.post("/api/agents/:id/secrets/:secretId", async c => {
    const input = z.object({ revision: z.number().int().nonnegative(), granted: z.boolean() }).strict().parse(await c.req.json());
    const scope = c.get("principal"), id = c.req.param("id");
    if (!(await runtime.listAgents(scope)).some(agent => agent.id === id && !agent.archived)) throw new ConnectionError(404, "Agent not found.");
    return c.json(await options.mcpConnections.grantNamedSecret(scope, c.req.param("secretId"), id, input.revision, input.granted));
  });
  app.get("/api/connections", async c => c.json({ connections: await runtime.listMcpConnections(c.get("principal")) }));
  app.post("/api/connections/authorize", async c => {
    const input = connectionSchema.parse(await c.req.json());
    const result = await options.mcpConnections.start(c.get("principal"), input);
    await runtime.refreshMcpConnections(result.id);
    return c.json(result);
  });
  app.post("/api/connections/oauth/complete", async c => {
    const input = z.object({ response: z.string().max(16_384) }).strict().parse(await c.req.json());
    const result = await options.mcpConnections.complete(c.get("principal"), new URLSearchParams(input.response));
    await runtime.refreshMcpConnections(result.id);
    return c.json({ authorized: result.authorized, message: result.authorized
      ? "Authorization is complete. Return to Dispatch to save the connection on your agent."
      : "Authorization was not completed. Return to Dispatch to try again." });
  });
  app.post("/api/connections/:id/disconnect", async c => {
    z.object({}).strict().parse(await c.req.json());
    const available = await runtime.listMcpConnections(c.get("principal"));
    if (!available.some(item => item.id === c.req.param("id") && item.canManage)) throw new ConnectionError(404, "Connection not found.");
    try { await options.mcpConnections.revoke(c.get("principal"), c.req.param("id")); }
    finally { await runtime.refreshMcpConnections(c.req.param("id")); }
    return c.json({ connections: await runtime.listMcpConnections(c.get("principal")) });
  });
  app.post("/api/connections/:id/reconnect", async c => {
    z.object({}).strict().parse(await c.req.json());
    const available = await runtime.listMcpConnections(c.get("principal"));
    if (!available.some(item => item.id === c.req.param("id"))) throw new ConnectionError(404, "Connection not found.");
    await runtime.refreshMcpConnections(c.req.param("id"));
    return c.json({ connections: await runtime.listMcpConnections(c.get("principal")) });
  });
  app.get("/api/people", async (c) => c.json({ people: await auth.listCompanyPeople(c.get("principal").companyId) }));
  app.post("/api/project-archives/preview", async c => {
    const input = z.object({ archive: z.string().max(32 * 1024 * 1024) }).strict().parse(await c.req.json());
    return c.json({ preview: projectArchivePreview(decodeProjectArchive(input.archive)) });
  });
  app.post("/api/project-archives/import", async c => {
    const input = z.object({ archive: z.string().max(32 * 1024 * 1024), requestId }).strict().parse(await c.req.json());
    return c.json({ project: await runtime.importProjectArchive(c.get("principal"), decodeProjectArchive(input.archive), input.requestId) });
  });
  app.post("/api/projects/:id/export", async c => {
    const input = z.object({ chatIds: identities.max(100) }).strict().parse(await c.req.json());
    return c.json({ archive: await runtime.exportProjectArchive(c.get("principal"), c.req.param("id"), input.chatIds) });
  });
  app.get("/api/projects/:id/history", async c => c.json({ archive: await runtime.getProjectArchive(c.get("principal"), c.req.param("id")) }));
  app.get("/api/projects/:id/instructions", async c => {
    c.header("Cache-Control", "no-store");
    return c.json({ instructions: await runtime.getProjectInstructions(c.get("principal"), c.req.param("id")) });
  });
  app.post("/api/projects/:id/instructions", async c => {
    const input = z.object({ requestId, expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), content: z.string().max(50_000) }).strict().parse(await c.req.json());
    c.header("Cache-Control", "no-store");
    return c.json({ instructions: await runtime.saveProjectInstructions(c.get("principal"), c.req.param("id"), input) });
  });
  app.get("/api/projects/:id/spec", async c => {
    c.header("Cache-Control", "no-store");
    const revision = z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional().parse(c.req.query("revision"));
    return c.json({ spec: await runtime.getProjectMarkdown(c.get("principal"), c.req.param("id"), revision) });
  });
  app.post("/api/projects/:id/spec", async c => {
    const input = z.object({ requestId, expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER), content: z.string().max(512 * 1024) }).strict().parse(await c.req.json());
    c.header("Cache-Control", "no-store");
    return c.json({ spec: await runtime.saveProjectMarkdown(c.get("principal"), c.req.param("id"), input) });
  });
  app.get("/api/projects/:id/spec/legacy", async c => {
    c.header("Cache-Control", "no-store");
    return c.json({ spec: await runtime.getLegacyProjectSpec(c.get("principal"), c.req.param("id")) });
  });
  app.post("/api/projects/:id/spec/import", async c => {
    const input = z.object({ requestId, expectedProjectRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), sourceVersion: z.string().min(1).max(200), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(await c.req.json());
    c.header("Cache-Control", "no-store");
    return c.json({ spec: await runtime.importProjectMarkdown(c.get("principal"), c.req.param("id"), input) });
  });
  app.get("/api/projects", async (c) => c.json({ projects: await runtime.listProjects(c.get("principal")) }));
  app.post("/api/projects", async (c) => {
    const input = z.object({ requestId, name: z.string().trim().min(1).max(100), kind: z.literal("shared") }).strict().parse(await c.req.json());
    return c.json({ project: await runtime.createProject(c.get("principal"), input) }, 201);
  });
  app.post("/api/projects/:id", async c => {
    const input = z.object({ requestId, expectedRevision: z.number().int().positive(), name: z.string().trim().min(1).max(100),
      members: z.array(z.object({ userId: identity, role: z.enum(["manager", "member"]) }).strict()).min(1).max(1000)
        .refine(members => new Set(members.map(member => member.userId)).size === members.length && members.some(member => member.role === "manager"), "Choose unique members and retain at least one manager."),
      defaultAgentDefinitionIds: identities.max(50),
      cwd: z.string().trim().max(4096).nullable().optional(),
      repositories: projectRepositoriesSchema.optional(), spec: projectSpecSchema.nullable().optional(),
    }).strict().parse(await c.req.json());
    return c.json({ project: await runtime.saveProject(c.get("principal"), c.req.param("id"), input) });
  });
  app.get("/api/chats", async (c) => c.json({ chats: await runtime.listChats(c.get("principal")) }));
  app.post("/api/chats", async (c) => {
    const input = z.object({
      requestId, title: z.string().trim().min(1).max(200).optional(),
      agentDefinitionId: identity.optional(), agentDefinitionIds: identities.max(50).optional(), sharedProjectId: z.string().uuid().nullable().optional(),
    }).strict().refine(value => value.agentDefinitionId === undefined || value.agentDefinitionIds === undefined).parse(await c.req.json());
    return c.json(await runtime.createChat(c.get("principal"), input), 201);
  });
  app.get("/api/chats/:id", async (c) => c.json(await runtime.getChat(c.get("principal"), c.req.param("id"))));
  app.get("/api/chats/:id/history", async c => {
    const query = z.object({ threadId: z.string().max(300).optional(), before: z.string().max(1000).optional() }).parse(c.req.query());
    try { return c.json(await runtime.transcriptPage(c.get("principal"), c.req.param("id"), query)); }
    catch (error) { if (error instanceof HistoryCursorError) return c.json({ error: { code: "HISTORY_CHANGED", message: error.message } }, 409); throw error; }
  });
  app.get("/api/chats/:id/detail/:kind/:item", async c => {
    const kind = z.enum(["message", "activity"]).parse(c.req.param("kind"));
    const value = await runtime.publicDetail(c.get("principal"), c.req.param("id"), kind, c.req.param("item"));
    if (c.req.query("download") === "1") {
      c.header("Content-Disposition", 'attachment; filename="chat-detail.json"');
      return c.json(value);
    }
    if (kind === "message") return c.json(value);
    const activity = value as import("../src/shared/contracts.js").ParticipantActivity;
    const before = z.coerce.number().int().nonnegative().optional().parse(c.req.query("before"));
    return c.json(activityPage(activity, before));
  });
  app.post("/api/chats/:id/definition-of-done", async (c) => {
    const input = z.object({ markdown: z.string().max(20000), expectedRevision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) }).strict().parse(await c.req.json());
    return c.json(await runtime.saveDefinitionOfDone(c.get("principal"), c.req.param("id"), input));
  });
  app.post("/api/chats/:id/title", async (c) => {
    const input = z.object({ title: z.string().trim().min(1).max(200) }).strict().parse(await c.req.json());
    return c.json(await runtime.renameChat(c.get("principal"), c.req.param("id"), input.title));
  });
  app.post("/api/chats/:id/participants", async (c) => {
    const input = z.object({ requestId, agentDefinitionIds: identities.max(50).optional(), userIds: identities.optional() }).strict()
      .refine(value => (value.agentDefinitionIds?.length ?? 0) + (value.userIds?.length ?? 0) > 0).parse(await c.req.json());
    return c.json(await runtime.addParticipants(c.get("principal"), c.req.param("id"), input));
  });
  app.post("/api/chats/:id/instances", async (c) => {
    const input = z.object({ requestId, agentDefinitionId: identity,
      name: z.string().max(100).optional(), instructions: z.string().max(50_000).optional(),
    }).strict().parse(await c.req.json());
    return c.json(await runtime.createAgentInstance(c.get("principal"), c.req.param("id"), input));
  });
  app.post("/api/chats/:id/participants/:participantId/remove", async (c) => {
    z.object({}).strict().parse(await c.req.json());
    const participantId = identity.parse(c.req.param("participantId"));
    return c.json(await runtime.removeParticipant(c.get("principal"), c.req.param("id"), participantId));
  });
  app.post("/api/chats/:id/preferences", async (c) => {
    const input = z.object({ pinned: z.boolean().optional(), archived: z.boolean().optional() }).strict()
      .refine(value => value.pinned !== undefined || value.archived !== undefined).parse(await c.req.json());
    return c.json(await runtime.updateChat(c.get("principal"), c.req.param("id"), input));
  });
  app.post("/api/chats/:id/attachments", async c => {
    const principal = c.get("principal");
    await runtime.authorizeAttachmentUpload(principal, c.req.param("id"));
    const file = await readAttachmentUpload(c.req.raw);
    if (!await auth.isSessionValid(principal.sessionId)) return c.json({ error: { code: "unauthenticated", message: "Sign in to continue." } }, 401);
    return c.json({ attachment: await runtime.uploadAttachment(principal, c.req.param("id"), file) }, 201);
  });
  app.get("/api/chats/:id/attachments/:attachmentId", async c => {
    const attachmentId = z.string().uuid().parse(c.req.param("attachmentId"));
    const { attachment, bytes } = await runtime.downloadAttachment(c.get("principal"), c.req.param("id"), attachmentId);
    c.header("Content-Type", attachment.mimeType);
    c.header("Content-Length", String(attachment.size));
    c.header("Content-Security-Policy", "default-src 'none'; sandbox");
    const disposition = attachment.kind === "image" ? "inline" : "attachment";
    const name = encodeURIComponent(attachment.name).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
    c.header("Content-Disposition", `${disposition}; filename="attachment"; filename*=UTF-8''${name}`);
    return c.body(new Uint8Array(bytes));
  });
  app.post("/api/chats/:id/messages", async (c) => {
    const input = z.object({
      requestId, text: z.string().trim().max(100_000),
      threadId: identity.nullable().optional(), mentions: identities.optional(), agentMentions: identities.max(50).optional(),
      attachmentIds: z.array(z.string().uuid()).max(ATTACHMENT_MAX_COUNT).refine(ids => new Set(ids).size === ids.length).optional(),
    }).strict().refine(input => input.text.length > 0 || Boolean(input.attachmentIds?.length), "Add a message or attachment.").parse(await c.req.json());
    return c.json(await runtime.submitAndGetChat(c.get("principal"), c.req.param("id"), input), 202);
  });
  app.post("/api/chats/:id/stop", async (c) => {
    z.object({}).strict().parse(await c.req.json());
    return c.json(await runtime.stop(c.get("principal"), c.req.param("id")));
  });
  app.post("/api/chats/:id/composing", async (c) => {
    const input = z.object({ clientId: z.string().uuid(), sequence: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), active: z.boolean() }).strict().parse(await c.req.json());
    await runtime.composing(c.get("principal"), c.req.param("id"), input);
    return c.json({ ok: true });
  });
  app.get("/api/chats/:id/events", async (c) => {
    const principal = c.get("principal");
    const watch = await runtime.watchChat(principal, c.req.param("id"));
    return new Response(snapshotStream(watch, () => auth.isSessionValid(principal.sessionId), c.req.raw.signal, (listener) => auth.onRevocation(listener)), {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-store", "X-Accel-Buffering": "no" },
    });
  });
  app.post("/api/bundles/starters/developer", async c => c.json(createDeveloperStarter(await c.req.json())));
  app.get("/api/bundles/github", async c => c.json({ installations: await runtime.listGitHubBundles(c.get("principal")) }));
  app.post("/api/bundles/github/preview", async c => {
    const input = z.object({ source: githubSourceSchema, installationId: z.string().uuid().optional() }).strict().parse(await c.req.json());
    const fetched = await fetchGithubBundle(input.source);
    return c.json(await runtime.previewGitHubBundle(c.get("principal"), fetched.bundle, fetched.source, input.installationId));
  });
  app.post("/api/bundles/github/apply", async c => {
    const input = z.object({ previewId: z.string().uuid(), requestId }).strict().parse(await c.req.json());
    return c.json(await runtime.applyGitHubBundle(c.get("principal"), input));
  });
  const archiveSchema = z.object({ archive: z.string().max(Math.ceil(BUNDLE_MAX_BYTES / 3) * 4).refine(value => value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), "Invalid base64 archive."), requestId: requestId.optional() }).strict();
  app.post("/api/bundles/export", async c => {
    const bundle = await runtime.exportBundle(c.get("principal"), bundleExportSchema.parse(await c.req.json()));
    return c.json({ archive: encodeBundle(bundle).toString("base64"), filename: `${bundle.id}-${bundle.version}.zip` });
  });
  app.post("/api/bundles/preview", async c => {
    const input = archiveSchema.parse(await c.req.json());
    return c.json(await runtime.previewBundle(c.get("principal"), decodeBundle(Buffer.from(input.archive, "base64"))));
  });
  app.post("/api/bundles/import", async c => {
    const input = archiveSchema.extend({ requestId }).parse(await c.req.json());
    return c.json(await runtime.importBundle(c.get("principal"), decodeBundle(Buffer.from(input.archive, "base64")), input.requestId));
  });
  app.get("/api/skills", async (c) => c.json({ skills: await runtime.listSkills(c.get("principal")) }));
  app.get("/api/skills/:id/revisions/:revision", async (c) => c.json({ skill: await runtime.getSkill(c.get("principal"), z.string().uuid().parse(c.req.param("id")), z.coerce.number().int().positive().parse(c.req.param("revision"))) }));
  app.post("/api/skills", async (c) => c.json({ skill: await runtime.saveSkill(c.get("principal"), z.object({
    id: z.string().uuid().optional(), expectedRevision: z.number().int().positive().optional(), requestId,
    name: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(500),
    instructions: z.string().trim().min(1).max(50_000),
  }).strict().parse(await c.req.json())) }));
  app.get("/api/agent-management/grants", async c => c.json(await runtime.managementGrants(c.get("principal"))));
  app.post("/api/agent-management/grants", async c => c.json({ grant: await runtime.saveManagementGrant(c.get("principal"), await c.req.json()) }));
  app.get("/api/agents", async (c) => c.json({ agents: await runtime.listAgents(c.get("principal")) }));
  app.get("/api/agents/:id/evaluation", async c => c.json(await runtime.evaluationProfile(c.get("principal"), c.req.param("id"))));
  app.get("/api/agents/:id/evaluation/revisions/:revision", async c => c.json({ profile: await runtime.evaluationProfileRevision(c.get("principal"), c.req.param("id"), parseEvaluationRevision(c.req.param("revision"))) }));
  app.post("/api/agents/:id/evaluation", async c => c.json({ profile: await runtime.saveEvaluationProfile(c.get("principal"), c.req.param("id"), await c.req.json()) }));
  app.get("/api/agents/:id/connections", async (c) => c.json({ connections: await runtime.agentConnections(c.get("principal"), c.req.param("id")) }));
  app.post("/api/agents/:id/connections/:connection/reconnect", async (c) => {
    z.object({}).strict().parse(await c.req.json());
    return c.json({ connections: await runtime.reconnectAgentConnection(c.get("principal"), c.req.param("id"), c.req.param("connection")) });
  });
  app.post("/api/agents", async (c) => c.json({ agent: await runtime.saveAgent(c.get("principal"), agentSchema.parse(await c.req.json())) }));
  app.post("/api/agents/:id/archive", async (c) => {
    const input = z.object({ expectedRevision: z.number().int().positive() }).strict().parse(await c.req.json());
    return c.json({ agent: await runtime.archiveAgent(c.get("principal"), c.req.param("id"), input.expectedRevision) });
  });
  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Endpoint not found." } }, 404));
  if (options.clientDir) {
    app.use("*", serveStatic({ root: options.clientDir }));
    app.get("*", serveStatic({ path: `${options.clientDir}/index.html` }));
  }
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError) return c.json({ error: { code: "invalid_request", message: "The request is invalid. Check the fields and try again." } }, 400);
    if (error instanceof ProviderSetupError || error instanceof ProjectArchiveError || error instanceof BundleError || error instanceof EvaluationError || error instanceof ManagementError || error instanceof AttachmentError || error instanceof ProjectAccessError || error instanceof ProjectSpecError || error instanceof RuntimeError || error instanceof CollaborationError || error instanceof ConnectionError) return c.json({ error: { code: "runtime", message: error.message } }, error.status as 400);
    // Raw exceptions can contain database statements, URLs or credentials.
    console.error("Dispatch request failed");
    return c.json({ error: { code: "internal", message: "The request could not be completed. Try again." } }, 500);
  });
  return app;
}

type ChatWatch = Awaited<ReturnType<RuntimeService["watchChat"]>>;

/** Each subscriber retains at most the latest complete snapshot under backpressure. */
function snapshotStream(watch: ChatWatch, isValid: () => Promise<boolean>, signal: AbortSignal, onRevocation: (listener: () => void | Promise<void>) => () => void) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let pending: ChatSnapshot | undefined = watch.value;
  let delivered: ChatSnapshot | undefined;
  let stopped = false;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval>;
  let cleanup: Promise<void> | undefined;
  function close() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    unsubscribe();
    signal.removeEventListener("abort", close);
    cleanup = Promise.resolve().then(async () => { await watch.stop(); });
    void cleanup.catch(() => {});
    controller.close();
  }
  async function valid() {
    if (stopped) return false;
    try { if (await isValid()) return !stopped; } catch { /* Fail closed on authorization storage failure. */ }
    if (stopped) return false;
    controller.enqueue(encoder.encode('event: session-ended\ndata: {"message":"Sign in to continue."}\n\n'));
    close();
    return false;
  }
  let flushing = false;
  async function flush() {
    if (flushing || stopped || !pending || (controller.desiredSize ?? 0) <= 0) return;
    flushing = true;
    const snapshot = pending;
    pending = undefined;
    try {
      if (!await valid()) return;
      await watch.deliver(async () => {
        if (await valid()) {
          const event = delivered ? "delta" : "snapshot";
          const payload = delivered ? chatDelta(delivered, snapshot) : snapshot;
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`));
          delivered = snapshot;
        }
      });
    } catch { close(); }
    finally { flushing = false; }
    if (pending && !stopped) void flush();
  }
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      heartbeat = setInterval(async () => {
        if (!await valid()) return;
        if (pending) void flush();
        else if ((controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
      unsubscribe = onRevocation(async () => { await valid(); if (stopped) await cleanup; });
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) { close(); return; }
      void watch.closed.then(close, close);
      void flush();
      if (stopped) return;
      try { watch.start(async (snapshot) => { if (!stopped) { pending = snapshot; void flush(); } }); }
      catch { close(); }
    },
    pull() { return flush(); },
    async cancel() {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeat);
      unsubscribe();
      signal.removeEventListener("abort", close);
      await watch.stop();
    },
  });
}
