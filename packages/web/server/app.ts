import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { createAuth, AuthPrincipal } from "./auth.js";
import { ProjectAccessError } from "./project-access.js";
import { RuntimeError, type DispatchRuntime } from "./runtime.js";
import { CollaborationError } from "./collaboration/shared.js";
import type { ApplicationConfig, ChatSnapshot } from "../src/shared/contracts.js";
import { ConnectionError, type McpConnections } from "./mcp-connections.js";
import { AttachmentError, readAttachmentUpload } from "./attachments.js";
import { ATTACHMENT_MAX_COUNT } from "../src/shared/contracts.js";
import { EvaluationError, parseEvaluationRevision } from "./evaluations.js";
import { ManagementError } from "./agent-grants.js";
import { randomToken } from "./auth/crypto.js";

type Auth = ReturnType<typeof createAuth>;
type AppOptions = {
  auth: Auth;
  runtime: DispatchRuntime;
  mcpConnections: McpConnections;
  origin: string;
  configuration: () => Promise<ApplicationConfig>;
  clientDir?: string;
};
const requestId = z.string().trim().min(1).max(200);
const projectId = z.string().uuid().nullable().optional();
const identity = z.string().min(1).max(200);
const identities = z.array(identity).refine(values => new Set(values).size === values.length, "Choose each participant once.");
const agentSchema = z.object({
  id: z.string().min(1).max(200).optional(), expectedRevision: z.number().int().positive().optional(),
  name: z.string().trim().min(1).max(100), description: z.string().max(500), instructions: z.string().max(50_000),
  provider: z.string().min(1).max(100), modelId: z.string().min(1).max(200),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  capabilities: z.array(z.enum(["files-and-commands", "image-generation"])).max(2).optional(),
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
          if(window.opener){window.opener.postMessage({type:"dispatch-mcp-authorized"},${JSON.stringify(options.origin)});window.opener.postMessage({type:"dispatch-wiki-authorized"},${JSON.stringify(options.origin)});if(result.authorized)window.close();}
        }catch(error){document.getElementById("heading").textContent="Connection needs attention";document.getElementById("message").textContent=error.message+" Open Dispatch to sign in if needed, then try again here.";}
        finally{button.disabled=false;}
      }
      button.addEventListener("click",complete);void complete();
    </script></html>`);
  });
  const jsonLimit = bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: { code: "too_large", message: "Request is too large." } }, 413) });
  const isUpload = (method: string, path: string) => method === "POST" && /^\/api\/chats\/[^/]+\/attachments$/.test(path);
  // Upload bytes are counted only after authentication and conversation authorization below.
  app.use("/api/*", (c, next) => isUpload(c.req.method, c.req.path) ? next() : jsonLimit(c, next));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(c.req.method)) {
      if (c.req.header("origin") !== options.origin) return c.json({ error: { code: "origin", message: "Request origin is not allowed." } }, 403);
      const type = isUpload(c.req.method, c.req.path) ? "multipart/form-data" : "application/json";
      if (c.req.header("content-type")?.split(";")[0].trim().toLowerCase() !== type) return c.json({ error: { code: "content_type", message: `Use a ${type} request.` } }, 415);
    }
    const response = await auth.handle(c.req.raw);
    if (response) return response;
    const principal = auth.authenticate(c.req.raw);
    if (!principal) return c.json({ error: { code: "unauthenticated", message: "Sign in to continue." } }, 401);
    c.set("principal", principal);
    await next();
  });
  app.get("/api/config", async (c) => c.json(await options.configuration()));
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
  app.get("/api/people", (c) => c.json({ people: auth.listCompanyPeople(c.get("principal").companyId) }));
  app.get("/api/projects", async (c) => c.json({ projects: await runtime.listProjects(c.get("principal")) }));
  app.post("/api/projects", async (c) => {
    const input = z.object({ requestId, name: z.string().trim().min(1).max(100), kind: z.literal("shared").optional() }).strict().parse(await c.req.json());
    return c.json({ project: await runtime.createProject(c.get("principal"), input) }, 201);
  });
  app.post("/api/projects/:id", async c => {
    const input = z.object({ requestId, expectedRevision: z.number().int().positive(), name: z.string().trim().min(1).max(100),
      members: z.array(z.object({ userId: identity, role: z.enum(["manager", "member"]) }).strict()).min(1).max(1000)
        .refine(members => new Set(members.map(member => member.userId)).size === members.length && members.some(member => member.role === "manager"), "Choose unique members and retain at least one manager."),
      defaultAgentDefinitionIds: identities.max(50),
    }).strict().parse(await c.req.json());
    return c.json({ project: await runtime.saveProject(c.get("principal"), c.req.param("id"), input) });
  });
  app.get("/api/chats", async (c) => c.json({ chats: await runtime.listChats(c.get("principal")) }));
  app.post("/api/chats", async (c) => {
    const input = z.object({
      requestId, title: z.string().trim().min(1).max(200).optional(),
      agentDefinitionId: identity.optional(), agentDefinitionIds: identities.max(50).optional(), projectId, sharedProjectId: z.string().uuid().nullable().optional(),
    }).strict().refine(value => value.agentDefinitionId === undefined || value.agentDefinitionIds === undefined).parse(await c.req.json());
    return c.json(await runtime.createChat(c.get("principal"), input), 201);
  });
  app.get("/api/chats/:id", async (c) => c.json(await runtime.getChat(c.get("principal"), c.req.param("id"))));
  app.post("/api/chats/:id/title", async (c) => {
    const input = z.object({ title: z.string().trim().min(1).max(200) }).strict().parse(await c.req.json());
    return c.json(await runtime.renameChat(c.get("principal"), c.req.param("id"), input.title));
  });
  app.post("/api/chats/:id/participants", async (c) => {
    const input = z.object({ requestId, agentDefinitionIds: identities.optional(), userIds: identities.optional() }).strict()
      .refine(value => (value.agentDefinitionIds?.length ?? 0) + (value.userIds?.length ?? 0) > 0).parse(await c.req.json());
    return c.json(await runtime.addParticipants(c.get("principal"), c.req.param("id"), input));
  });
  app.post("/api/chats/:id/preferences", async (c) => {
    const input = z.object({ pinned: z.boolean().optional(), archived: z.boolean().optional(), projectId }).strict()
      .refine(value => value.pinned !== undefined || value.archived !== undefined || value.projectId !== undefined).parse(await c.req.json());
    return c.json(await runtime.updateChat(c.get("principal"), c.req.param("id"), input));
  });
  app.post("/api/chats/:id/attachments", async c => {
    const principal = c.get("principal");
    await runtime.authorizeAttachmentUpload(principal, c.req.param("id"));
    const file = await readAttachmentUpload(c.req.raw);
    if (!auth.isSessionValid(principal.sessionId)) return c.json({ error: { code: "unauthenticated", message: "Sign in to continue." } }, 401);
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
      threadId: identity.nullable().optional(), mentions: identities.optional(), agentMentions: identities.optional(),
      attachmentIds: z.array(z.string().uuid()).max(ATTACHMENT_MAX_COUNT).refine(ids => new Set(ids).size === ids.length).optional(),
    }).strict().refine(input => input.text.length > 0 || Boolean(input.attachmentIds?.length), "Add a message or attachment.").parse(await c.req.json());
    await runtime.submit(c.get("principal"), c.req.param("id"), input);
    return c.json(await runtime.getChat(c.get("principal"), c.req.param("id")), 202);
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
    if (error instanceof EvaluationError || error instanceof ManagementError || error instanceof AttachmentError || error instanceof ProjectAccessError || error instanceof RuntimeError || error instanceof CollaborationError || error instanceof ConnectionError) return c.json({ error: { code: "runtime", message: error.message } }, error.status as 400);
    console.error("Dispatch request failed:", error);
    return c.json({ error: { code: "internal", message: "The request could not be completed. Try again." } }, 500);
  });
  return app;
}

type ChatWatch = Awaited<ReturnType<DispatchRuntime["watchChat"]>>;

/** Each subscriber retains at most the latest complete snapshot under backpressure. */
function snapshotStream(watch: ChatWatch, isValid: () => boolean, signal: AbortSignal, onRevocation: (listener: () => void) => () => void) {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array>;
  let pending: ChatSnapshot | undefined = watch.value;
  let stopped = false;
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval>;
  function close() {
    if (stopped) return;
    stopped = true;
    clearInterval(heartbeat);
    unsubscribe();
    signal.removeEventListener("abort", close);
    void watch.stop();
    controller.close();
  }
  function valid() {
    if (stopped) return false;
    if (isValid()) return true;
    controller.enqueue(encoder.encode('event: session-ended\ndata: {"message":"Sign in to continue."}\n\n'));
    close();
    return false;
  }
  let flushing = false;
  async function flush() {
    if (flushing || !valid() || !pending || (controller.desiredSize ?? 0) <= 0) return;
    flushing = true;
    const snapshot = pending;
    pending = undefined;
    try {
      await watch.deliver(() => {
        if (valid()) controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`));
      });
    } catch { close(); }
    finally { flushing = false; }
    if (pending && !stopped) void flush();
  }
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      heartbeat = setInterval(() => {
        if (!valid()) return;
        if (pending) void flush();
        else if ((controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
      unsubscribe = onRevocation(() => { valid(); });
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
