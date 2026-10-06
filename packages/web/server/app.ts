import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { serveStatic } from "@hono/node-server/serve-static";
import { z } from "zod";
import type { createAuth, AuthPrincipal } from "./auth.js";
import { RuntimeError, type DispatchRuntime } from "./runtime.js";
import { CollaborationError } from "./collaboration/shared.js";
import type { ApplicationConfig, ChatSnapshot } from "../src/shared/contracts.js";

type Auth = ReturnType<typeof createAuth>;
type AppOptions = {
  auth: Auth;
  runtime: DispatchRuntime;
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
}).strict();

export function createApp(options: AppOptions) {
  const { auth, runtime } = options;
  const app = new Hono<{ Variables: { principal: AuthPrincipal } }>();
  app.use("*", async (c, next) => {
    c.header("X-Content-Type-Options", "nosniff");
    c.header("Referrer-Policy", "no-referrer");
    c.header("X-Frame-Options", "DENY");
    await next();
  });
  app.use("/api/*", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: { code: "too_large", message: "Request is too large." } }, 413) }));
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (!["GET", "HEAD"].includes(c.req.method)) {
      if (c.req.header("origin") !== options.origin) return c.json({ error: { code: "origin", message: "Request origin is not allowed." } }, 403);
      if (!c.req.header("content-type")?.toLowerCase().startsWith("application/json")) return c.json({ error: { code: "content_type", message: "Use an application/json request." } }, 415);
    }
    const response = await auth.handle(c.req.raw);
    if (response) return response;
    const principal = auth.authenticate(c.req.raw);
    if (!principal) return c.json({ error: { code: "unauthenticated", message: "Sign in to continue." } }, 401);
    c.set("principal", principal);
    await next();
  });
  app.get("/api/config", async (c) => c.json(await options.configuration()));
  app.get("/api/people", (c) => c.json({ people: auth.listCompanyPeople(c.get("principal").companyId) }));
  app.get("/api/projects", async (c) => c.json({ projects: await runtime.listProjects(c.get("principal")) }));
  app.post("/api/projects", async (c) => {
    const input = z.object({ requestId, name: z.string().trim().min(1).max(100) }).strict().parse(await c.req.json());
    return c.json({ project: await runtime.createProject(c.get("principal"), input) }, 201);
  });
  app.get("/api/chats", async (c) => c.json({ chats: await runtime.listChats(c.get("principal")) }));
  app.post("/api/chats", async (c) => {
    const input = z.object({
      requestId, title: z.string().trim().min(1).max(200).optional(),
      agentDefinitionId: identity.optional(), agentDefinitionIds: identities.refine(values => values.length > 0).optional(), projectId,
    }).strict().refine(value => value.agentDefinitionId === undefined || value.agentDefinitionIds === undefined).parse(await c.req.json());
    return c.json(await runtime.createChat(c.get("principal"), input), 201);
  });
  app.get("/api/chats/:id", async (c) => c.json(await runtime.getChat(c.get("principal"), c.req.param("id"))));
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
  app.post("/api/chats/:id/messages", async (c) => {
    const input = z.object({
      requestId, text: z.string().trim().min(1).max(100_000),
      threadId: identity.nullable().optional(), mentions: identities.optional(),
    }).strict().parse(await c.req.json());
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
  app.get("/api/agents", async (c) => c.json({ agents: await runtime.listAgents(c.get("principal")) }));
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
    if (error instanceof RuntimeError || error instanceof CollaborationError) return c.json({ error: { code: "runtime", message: error.message } }, error.status as 400);
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
  function flush() {
    if (!valid() || !pending || (controller.desiredSize ?? 0) <= 0) return;
    controller.enqueue(encoder.encode(`event: snapshot\ndata: ${JSON.stringify(pending)}\n\n`));
    pending = undefined;
  }
  return new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      heartbeat = setInterval(() => {
        if (!valid()) return;
        if (pending) flush();
        else if ((controller.desiredSize ?? 0) > 0) controller.enqueue(encoder.encode(": heartbeat\n\n"));
      }, 15_000);
      unsubscribe = onRevocation(() => { valid(); });
      signal.addEventListener("abort", close, { once: true });
      if (signal.aborted) { close(); return; }
      void watch.closed.then(close, close);
      flush();
      if (stopped) return;
      try { watch.start(async (snapshot) => { if (!stopped) { pending = snapshot; flush(); } }); }
      catch { close(); }
    },
    pull() { flush(); },
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
