import { serve } from "@hono/node-server";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { controllerRequest } from "./controller-transport.js";
import { ControllerDispatch } from "./controller-dispatch.js";
import { ControllerRendezvous, controllerIdentitySchema, type ControllerIdentity } from "./controller-rendezvous.js";
import { readRoutingStoreConfig } from "./routing-config.js";
import { verifiedPostgresConfig } from "../storage/postgres/tls.js";
import { readRestrictedConfigurationFile } from "../storage/restricted-config-file.js";
import { tokenMatches } from "./identity.js";

export type ControllerOwner = {
  app: Hono; supportReady?(): boolean | Promise<boolean>; ready(): boolean | Promise<boolean>; retire(beforeSupportClose?: () => Promise<void>): Promise<void>;
};
const schema = z.object({
  databaseConfigFile: z.string().startsWith("/"), tokenFile: z.string().startsWith("/"),
  endpoint: z.url().optional(), host: z.string().default("0.0.0.0"), port: z.number().int().min(1).max(65535),
  peerTls: z.object({ caFile: z.string().startsWith("/"), serverName: z.string().min(1) }).strict().optional(),
  tls: z.object({ keyFile: z.string().startsWith("/"), certFile: z.string().startsWith("/") }).strict().optional(),
}).strict();
const peerHeader = "X-Dispatch-Controller-Token";
const hopHeader = "X-Dispatch-Controller-Target";

/** Planned rolling ownership transfer; peer discovery is private and authenticated.
 * Candidates transfer before rollout readiness, not during ECS's stop countdown. */
export async function serveRollingController(role: "backend" | "launcher", openOwner: () => Promise<ControllerOwner>) {
  const filename = process.env.DISPATCH_CONTROLLER_CONFIG_FILE;
  if (!filename) throw new Error("Rolling controller configuration is required.");
  const config = schema.parse(JSON.parse((await readRestrictedConfigurationFile(filename, false)).toString("utf8")));
  let endpoint = config.endpoint;
  if (!endpoint) {
    const metadataUrl = new URL(process.env.ECS_CONTAINER_METADATA_URI_V4 ?? "");
    if (metadataUrl.protocol !== "http:" || metadataUrl.hostname !== "169.254.170.2" || metadataUrl.username || metadataUrl.password || metadataUrl.search || metadataUrl.hash)
      throw new Error("Controller requires an explicit direct endpoint or ECS container metadata.");
    const metadata = await (await fetch(metadataUrl, { redirect: "error", signal: AbortSignal.timeout(3000) })).json();
    const networks = z.object({ Networks: z.array(z.object({ NetworkMode: z.string(), IPv4Addresses: z.array(z.ipv4()) })) }).parse(metadata).Networks;
    const addresses = networks.filter(network => network.NetworkMode === "awsvpc").flatMap(network => network.IPv4Addresses);
    if (addresses.length !== 1) throw new Error("Controller requires one awsvpc IPv4 endpoint.");
    endpoint = `${config.tls ? "https" : "http"}://${addresses[0]}:${config.port}`;
  }
  if (Number(new URL(endpoint).port || (config.tls ? 443 : 80)) !== config.port)
    throw new Error("Controller direct endpoint must match its listener port.");
  const database = await readRoutingStoreConfig(config.databaseConfigFile);
  const token = (await readRestrictedConfigurationFile(config.tokenFile, true)).toString("utf8").trim();
  if (!/^[A-Za-z0-9_-]{43,256}$/.test(token)) throw new Error("Controller peer token must be independently provisioned.");
  const url = await readRestrictedConfigurationFile(database.databaseUrlFile, true);
  const ca = (await readRestrictedConfigurationFile(database.databaseCaFile, false)).toString("utf8");
  const rendezvous = await ControllerRendezvous.open({ database: verifiedPostgresConfig(url.toString("utf8").trim(), ca),
    installationId: database.installationId, role, endpoint });
  url.fill(0);
  function lifecycle(event: string) {
    console.info(JSON.stringify({ timestamp: new Date().toISOString(), role,
      instanceId: rendezvous.identity.instanceId, event }));
  }
  const peerTls = config.peerTls ? { ca: (await readRestrictedConfigurationFile(config.peerTls.caFile, false)).toString("utf8"), servername: config.peerTls.serverName } : undefined;
  if ((new URL(endpoint!).protocol === "https:") !== !!config.tls || (config.tls && !peerTls))
    throw new Error("Controller listener and peer TLS configuration must agree.");
  const gate = new ControllerDispatch();
  const supportGate = new ControllerDispatch();
  const proxyGate = new ControllerDispatch();
  let owner: ControllerOwner | undefined;
  let activated = false;
  let retired = false;
  let stopping = false;
  let transfer: Promise<void> | undefined;
  let transferTarget: ControllerIdentity | undefined;
  let transferStarted = 0;
  const app = new Hono();
  const equal = (a: ControllerIdentity, b: ControllerIdentity) => a.instanceId === b.instanceId && a.endpoint === b.endpoint
    && a.installationId === b.installationId && a.role === b.role;
  async function peer(identity: ControllerIdentity, path: string, body?: unknown) {
    if (new URL(identity.endpoint).protocol !== new URL(endpoint!).protocol) throw new Error("Controller peer transport mismatch.");
    const payload = body === undefined ? undefined : new Response(JSON.stringify(body)).body;
    const response = await controllerRequest(new URL(path, identity.endpoint), {
      method: body === undefined ? "GET" : "POST", signal: AbortSignal.timeout(3000), tls: peerTls,
      headers: new Headers({ [peerHeader]: `Bearer ${token}`, "Content-Type": "application/json" }), body: payload });
    if (!response.ok) throw new Error("Controller peer unavailable.");
    return response;
  }
  async function verify(identity: ControllerIdentity) {
    const value = await (await peer(identity, "/internal/controller/identity")).json();
    const parsed = z.object({ identity: controllerIdentitySchema, ready: z.boolean(), supportReady: z.boolean() }).strict().parse(value);
    if (!equal(parsed.identity, identity)) throw new Error("Controller peer identity mismatch.");
    return parsed;
  }
  let observation: Promise<{ identity: ControllerIdentity; ready: boolean; supportReady: boolean } | undefined> | undefined;
  let observedUntil = 0;
  async function remoteOwner(workerSupport = false): Promise<ControllerIdentity | undefined> {
    if (!observation || performance.now() >= observedUntil) {
      observedUntil = Infinity;
      observation = (async () => {
        const record = await rendezvous.discover();
        if (!record || equal(record.owner, rendezvous.identity) || record.phase === "released") return undefined;
        const peer = await verify(record.owner);
        return { ...peer, ready: record.phase === "ready" && peer.ready };
      })().finally(() => { observedUntil = performance.now() + 200; });
    }
    const peer = await observation;
    return peer && (workerSupport ? peer.supportReady : peer.ready) ? peer.identity : undefined;
  }
  async function localAvailable(workerSupport: boolean) {
    if (!owner || retired) return false;
    if (workerSupport) return !supportGate.holding && supportGate.available && await (owner.supportReady?.() ?? owner.ready());
    return activated && !gate.holding && gate.available && await owner.ready();
  }
  async function ready() {
    if (stopping || !gate.available) return false;
    if (owner && activated && !retired && !gate.holding) return owner.ready();
    if (!gate.waitingAvailable) return false;
    // The old task retains a bounded waiting path while a verified successor opens.
    if (activated && transfer && performance.now() - transferStarted < 30_000) return true;
    return activated && retired && !!await remoteOwner();
  }
  app.get("/internal/ready", async c => {
    try { const available = await ready(); return c.text(available ? "ok" : "unavailable", available ? 200 : 503); }
    catch { return c.text("unavailable", 503); }
  });
  app.get("/internal/health", c => c.text("ok"));
  app.use("/internal/controller/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (c.req.header("Origin") || !tokenMatches(token, c.req.header(peerHeader))) return c.text("Forbidden", 403);
    return next();
  });
  app.use("/internal/controller/*", bodyLimit({ maxSize: 8192 }));
  app.get("/internal/controller/identity", async c => c.json({ identity: rendezvous.identity,
    ready: await localAvailable(false), supportReady: await localAvailable(true) }));
  app.post("/internal/controller/handover", async c => {
    const target = controllerIdentitySchema.parse(await c.req.json());
    if (target.role !== role || target.installationId !== database.installationId
      || equal(target, rendezvous.identity)) return c.text("Invalid target", 409);
    await verify(target);
    if (transferTarget && !equal(transferTarget, target)) return c.text("Transfer already selected", 409);
    if (!owner || !activated || retired) return c.text("Not active", 409);
    if (!transfer) {
      transferTarget = target;
      // Do not seal dispatch until admitted requests reach their natural idle boundary.
      transfer = (async () => {
        await gate.retire();
        transferStarted = performance.now();
        await rendezvous.handover(target, async () => { await owner!.retire(() => supportGate.retire()); });
        retired = true;
        lifecycle("ownership-released");
      })().catch(() => { gate.fail(); });
    }
    return c.json({ accepted: true }, 202);
  });
  app.all("*", async c => {
    const request = c.req.raw;
    if (request.headers.has(hopHeader) && (!tokenMatches(token, request.headers.get(peerHeader) ?? undefined)
      || request.headers.get(hopHeader) !== rendezvous.identity.instanceId)) return c.text("Forbidden", 403);
    const workerSupport = role === "backend" && c.req.path.startsWith("/internal/workers/");
    const dispatchGate = workerSupport ? supportGate : gate;
    const maintenance = ["/internal/undrain", "/internal/drain", "/internal/status"].includes(c.req.path);
    if (owner && !retired && !dispatchGate.holding && (await localAvailable(workerSupport) || maintenance)) {
      const accepted = dispatchGate.tryRun(request, async value => owner!.app.fetch(value));
      if (accepted) return accepted;
    }
    // A claimed local owner may intentionally keep admission closed at startup.
    // Reject public work without consuming handover waiters or blocking maintenance.
    if (owner && !retired && !dispatchGate.holding && !workerSupport) return c.text("Controller unavailable", 503);
    // Admission is synchronous. Once accepted, its promise is never replayed.
    const route = await gate.wait(request.signal, async signal => {
      if (await localAvailable(workerSupport)) {
        if (signal.aborted) return undefined;
        const response = dispatchGate.tryRun(request, async value => owner!.app.fetch(value));
        if (response) return { local: true as const, response };
      }
      const remote = await remoteOwner(workerSupport);
      return remote ? { local: false as const, remote } : undefined;
    });
    if (route.local) return route.response;
    const target = route.remote;
    const hops = Number(request.headers.get("X-Dispatch-Controller-Hops") ?? "0");
    if (!Number.isInteger(hops) || hops < 0 || hops >= 3) return c.text("Controller forwarding limit reached", 503);
    const headers = new Headers(request.headers);
    headers.delete(peerHeader); headers.delete(hopHeader);
    headers.set(peerHeader, `Bearer ${token}`); headers.set(hopHeader, target.instanceId);
    headers.set("X-Dispatch-Controller-Hops", String(hops + 1));
    for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"]) headers.delete(name);
    const incoming = new URL(request.url);
    const outgoing = new URL(target.endpoint);
    outgoing.pathname = incoming.pathname; outgoing.search = incoming.search;
    if (outgoing.origin !== new URL(target.endpoint).origin) throw new Error("Controller forwarding origin mismatch.");
    const forwarded = proxyGate.tryRun(request, async value => {
      const response = await controllerRequest(outgoing, { method: value.method, headers,
        body: value.body, signal: value.signal, tls: peerTls });
      const responseHeaders = new Headers(response.headers);
    responseHeaders.delete(peerHeader); responseHeaders.delete(hopHeader);
    responseHeaders.delete("X-Dispatch-Controller-Hops");
      return new Response(response.body, { status: response.status, statusText: response.statusText, headers: responseHeaders });
    });
    return forwarded ?? c.text("Controller withdrawing", 503);
  });
  app.onError((_error, c) => c.text("Controller unavailable; inspect persisted state before retrying mutations.", 503));
  const tls = config.tls ? { key: await readFile(config.tls.keyFile), cert: await readFile(config.tls.certFile), minVersion: "TLSv1.2" as const } : undefined;
  const listener = { fetch: app.fetch, hostname: config.host, port: config.port };
  const server = tls ? serve({ ...listener, createServer: createHttpsServer, serverOptions: tls }) : serve(listener);
  await once(server, "listening");
  async function activate() {
    if (!await rendezvous.claim()) return false;
    owner = await openOwner();
    while (!stopping && !await owner.ready()) await delay(200);
    if (stopping) throw new Error("Controller stopped during activation.");
    await rendezvous.markReady();
    activated = true;
    lifecycle("activated");
    return true;
  }
  const activation = (async () => {
    try {
      if (await activate()) return;
      const current = await rendezvous.discover();
      if (!current || current.phase !== "ready" || !(await verify(current.owner)).ready) throw new Error("Previous owner unavailable.");
      // One handover request only. An uncertain response is observed, never replayed.
      try { await peer(current.owner, "/internal/controller/handover", rendezvous.identity); } catch { /* Observe retained state. */ }
      while (!stopping) {
        if (await activate()) return;
        await delay(200);
      }
    } catch { gate.fail(); console.error("Controller activation failed; explicit recovery may be required."); }
  })();
  let shutdown: Promise<void> | undefined;
  function stop() {
    if (shutdown) return;
    lifecycle("shutdown-signal-received");
    void (shutdown ??= (async () => {
      stopping = true;
      // Withdraw the listener first; L7 deregistration must precede SIGTERM.
      const listenerClosed = new Promise<void>((resolve, reject) => {
        server.close(error => error ? reject(error) : resolve());
        if ("closeIdleConnections" in server) server.closeIdleConnections();
      });
      // Attach rejection immediately even while owner teardown is still pending.
      void listenerClosed.catch(() => { gate.fail(); });
      await activation;
      if (owner && !retired) {
        if (transfer) { await transfer; if (!retired) throw new Error("Handover incomplete."); }
        else {
          await rendezvous.handover(null, async () => { await gate.retire(); await owner!.retire(() => supportGate.retire()); });
          lifecycle("ownership-released");
        }
      }
      await proxyGate.retire();
      await listenerClosed;
      lifecycle("request-drain-complete");
      await rendezvous.close();
    })()).catch(() => { gate.fail(); process.exitCode = 1; console.error("Controller shutdown incomplete; explicit recovery required."); });
  }
  process.once("SIGTERM", stop); process.once("SIGINT", stop);
}
