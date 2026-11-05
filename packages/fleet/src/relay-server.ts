import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createConnection } from "node:net";
import type { SlackThreadInput } from "@dispatch/slack";
import type { FleetClient } from "./client.js";

export type FleetRelayOptions = {
  client: FleetClient;
  bridge: { start(run: string): { thread: SlackThreadInput; admitted: boolean; closing?: boolean; cancelling?: boolean }; event(run: string, event: unknown): Promise<void> };
  socket: string;
  stateRoot: string;
  teamId: string;
  slackToken: string;
  inference: { origin: string; key: string };
  wiki: {
    origin: string;
    call(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
    resource(uri: string, signal: AbortSignal): Promise<unknown>;
  };
  authorizeProfile?(profile: SlackThreadInput["profile"], input: SlackThreadInput): void | Promise<void>;
};
type RecordValue = Record<string, unknown>;
type Receipts = { messages: string[]; files: string[]; resources: Record<string, string[]> };
const object = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object.");
  return value as RecordValue;
};
const failure = (value: unknown) => typeof value === "string" && /^[a-z0-9_]+$/.test(value) ? value : "request_failed";
const methodFields: Record<string, readonly string[]> = {
  "auth.test": [],
  "assistant.threads.setStatus": ["channel_id", "thread_ts", "status", "loading_messages"],
  "chat.postMessage": ["channel", "thread_ts", "text", "blocks", "metadata", "client_msg_id", "parse", "link_names", "mrkdwn", "unfurl_links", "unfurl_media"],
  "chat.startStream": ["channel", "thread_ts", "recipient_team_id", "recipient_user_id", "markdown_text", "chunks", "task_display_mode"],
  "chat.appendStream": ["channel", "ts", "markdown_text", "chunks"],
  "chat.stopStream": ["channel", "ts", "markdown_text", "chunks", "blocks"],
  "chat.update": ["channel", "ts", "text", "blocks", "metadata", "parse", "link_names", "mrkdwn"],
  "chat.delete": ["channel", "ts"],
  "conversations.replies": ["channel", "ts", "cursor", "limit", "oldest", "latest", "inclusive", "include_all_metadata"],
  "files.getUploadURLExternal": ["filename", "length", "alt_txt", "snippet_type"],
  "files.completeUploadExternal": ["files", "channel_id", "thread_ts", "initial_comment"],
  "files.info": ["file"],
};

/** Root-side transport only: a native worker never receives service credentials. */
export async function startFleetRelay(options: FleetRelayOptions) {
  if (process.getuid?.() !== 0) throw new Error("The fleet relay must run as root.");
  const inference = new URL(options.inference.origin), wikiOrigin = new URL(options.wiki.origin).origin;
  if (inference.protocol !== "https:" || inference.username || inference.password || inference.pathname !== "/" || inference.search || inference.hash)
    throw new Error("Configure an HTTPS inference origin.");
  if (new URL(wikiOrigin).protocol !== "https:") throw new Error("Configure an HTTPS company wiki.");
  await mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
  await mkdir(dirname(options.socket), { recursive: true, mode: 0o700 });
  for (const path of [options.stateRoot, dirname(options.socket)]) {
    const stat = await lstat(path);
    const forbidden = path === options.stateRoot ? 0o077 : 0o022;
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== 0 || stat.mode & forbidden)
      throw new Error("Relay directories must have root-owned, protected permissions.");
  }
  try {
    const stat = await lstat(options.socket);
    if (!stat.isSocket() || stat.uid !== 0) throw new Error("Relay socket path is not a root-owned socket.");
    await new Promise<void>((resolve, reject) => {
      const probe = createConnection(options.socket);
      probe.once("connect", () => { probe.destroy(); reject(new Error("A company relay already owns this socket.")); });
      probe.once("error", error => {
        if (["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) resolve();
        else reject(error);
      });
    });
    await unlink(options.socket);
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const writes = new Map<string, Promise<void>>();
  const recordPath = (run: string) => join(options.stateRoot, run + ".json");
  async function receipts(run: string): Promise<Receipts> {
    try { return JSON.parse(await readFile(recordPath(run), "utf8")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { messages: [], files: [], resources: {} };
      throw error;
    }
  }
  async function retain(run: string, change: (value: Receipts) => void) {
    const pending = (writes.get(run) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const value = await receipts(run); change(value);
      const temporary = recordPath(run) + "." + randomUUID();
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
      await rename(temporary, recordPath(run));
      const directory = await open(options.stateRoot, "r");
      try { await directory.sync(); } finally { await directory.close(); }
    });
    writes.set(run, pending);
    try { await pending; } finally { if (writes.get(run) === pending) writes.delete(run); }
  }
  async function slackCall(method: string, args: RecordValue, signal: AbortSignal): Promise<RecordValue> {
    const response = await fetch("https://slack.com/api/" + method, {
      method: "POST", redirect: "error", signal,
      headers: { authorization: `Bearer ${options.slackToken}`, "content-type": "application/json; charset=utf-8" },
      body: JSON.stringify(args),
    });
    if (response.status === 429) return { ok: false, error: "ratelimited", retryAfter: Number(response.headers.get("retry-after")) || undefined };
    if (!response.ok) return { ok: false, error: "service_unavailable" };
    const result = object(await response.json());
    if (result.ok !== true) return { ok: false, error: failure(result.error) };
    return result;
  }
  const identity = await slackCall("auth.test", {}, AbortSignal.timeout(30_000));
  if (identity.ok !== true || identity.team_id !== options.teamId || typeof identity.user_id !== "string")
    throw new Error("Slack credentials do not match the configured company.");
  async function slack(run: string, input: SlackThreadInput, value: RecordValue, signal: AbortSignal) {
    const method = String(value.method), args = object(value.args), fields = methodFields[method];
    if (!fields || Object.keys(args).some(key => !fields.includes(key))) throw new Error("Unsupported Slack API request.");
    const saved = await receipts(run);
    if (method === "auth.test") return identity;
    if (["chat.postMessage", "chat.startStream", "assistant.threads.setStatus", "files.completeUploadExternal"].includes(method)) {
      if ((args.channel ?? args.channel_id) !== input.channel || args.thread_ts !== input.thread)
        throw new Error("Slack delivery belongs to the original thread.");
    } else if (method === "conversations.replies") {
      if (args.channel !== input.channel || args.ts !== input.thread) throw new Error("Slack read belongs to the original thread.");
    } else if (method.startsWith("chat.")) {
      if (args.channel !== input.channel || !saved.messages.includes(String(args.ts))) throw new Error("Use a retained message belonging to this run.");
    }
    if (method === "files.completeUploadExternal") {
      if (!Array.isArray(args.files) || !args.files.length || args.files.some(file => !saved.files.includes(String(object(file).id))))
        throw new Error("Use an upload allocated by this run.");
    }
    if (method === "files.info" && !saved.files.includes(String(args.file))) throw new Error("Use an upload allocated by this run.");
    const result = await slackCall(method, args, signal);
    if (result.ok === true) {
      await retain(run, state => {
        if (["chat.postMessage", "chat.startStream"].includes(method) && typeof result.ts === "string" && !state.messages.includes(result.ts)) state.messages.push(result.ts);
        if (method === "files.getUploadURLExternal" && typeof result.file_id === "string" && !state.files.includes(result.file_id)) state.files.push(result.file_id);
        if (method === "conversations.replies" && Array.isArray(result.messages)) {
          // Reconcile a delivery accepted by Slack before its receipt was saved.
          for (const item of result.messages) {
            const message = object(item);
            if (message.user === identity.user_id && message.thread_ts === input.thread && typeof message.ts === "string" && !state.messages.includes(message.ts)) state.messages.push(message.ts);
          }
        }
      });
    }
    return result;
  }
  async function wiki(run: string, input: SlackThreadInput, value: RecordValue, signal: AbortSignal) {
    const capabilities = input.profile?.capabilities ?? [];
    const conversation = String(value.conversation);
    if (!/^[a-zA-Z0-9:_-]+$/.test(conversation)) throw new Error("Invalid native conversation identity.");
    if (value.operation === "resource") {
      const uri = String(value.uri), url = new URL(uri);
      if (!capabilities.includes("wiki.read") || url.origin !== wikiOrigin || url.username || url.password || url.hash || !(await receipts(run)).resources[conversation]?.includes(uri))
        throw new Error("Use an exact company resource previously returned to this conversation.");
      return options.wiki.resource(uri, signal);
    }
    const name = String(value.name);
    const grant = ({ "wiki.search": "wiki.read", "wiki.read": "wiki.read", "wiki.traceSearch": "wiki.trace", "wiki.trace": "wiki.trace", "wiki.save": "wiki.write" } as Record<string, string>)[name];
    if (value.operation !== "call" || !grant || !capabilities.includes(grant)) throw new Error("The channel profile does not grant this wiki operation.");
    const result = await options.wiki.call(name, object(value.args), signal);
    const content = object(result).content;
    if (Array.isArray(content)) await retain(run, state => {
      const resources = state.resources[conversation] ??= [];
      for (const block of content) {
        const item = object(block);
        if (item.type !== "resource_link" || typeof item.uri !== "string") continue;
        const url = new URL(item.uri);
        if (url.origin === wikiOrigin && !url.username && !url.password && !url.hash && !resources.includes(item.uri)) resources.push(item.uri);
      }
    });
    return result;
  }
  const json = (response: ServerResponse, status: number, value: unknown) => {
    response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value));
  };
  const server = createServer((request, response) => {
    const lifetime = new AbortController();
    request.once("aborted", () => lifetime.abort());
    response.once("close", () => { if (!response.writableFinished) lifetime.abort(); });
    void handle(request, response, lifetime.signal).catch(() => {
      if (response.headersSent) response.destroy();
      else json(response, 403, { error: "Company relay request rejected; inspect the trusted coordinator." });
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse, signal: AbortSignal) {
    const run = request.headers["x-dispatch-run"], epoch = request.headers["x-dispatch-epoch"];
    if (typeof run !== "string" || !/^[a-f0-9]{64}$/.test(run) || typeof epoch !== "string" || !/^[1-9][0-9]*$/.test(epoch)) throw new Error("Missing fleet authority.");
    const assignment = await options.client.assignment(run);
    const path = request.url ?? "";
    if (assignment.fleet?.epoch !== Number(epoch)) throw new Error("Stale fleet authority.");
    if ((assignment.suspended || assignment.finished)
      && !["/company/slack/start", "/events", "/company/slack/api"].includes(path)
      && !(path === "/v1/catalog" && request.method === "GET")) throw new Error("The native run is stopping.");
    const bootstrap = options.bridge.start(run), input = bootstrap.thread;
    const closing = bootstrap.closing || assignment.suspended || assignment.finished;
    const effectsBlocked = closing || assignment.cancelPending;
    if (input.team !== options.teamId) throw new Error("Wrong company.");
    await options.authorizeProfile?.(input.profile, input);
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const bytes = Buffer.concat(chunks);
    if (path.startsWith("/v1/")) {
      if (effectsBlocked && request.method !== "GET") throw new Error("The Slack thread is closing.");
      if (!(request.method === "GET" && path === "/v1/catalog") && !(request.method === "POST" && /^\/v1\/(responses|connections\/[a-zA-Z0-9_.:-]+(?:\/messages)?)$/.test(path))) throw new Error("Unsupported inference route.");
      const upstream = await fetch(new URL(path, inference), {
        method: request.method, redirect: "error", signal,
        headers: { authorization: `Bearer ${options.inference.key}`, "content-type": "application/json" },
        ...(request.method === "POST" ? { body: bytes } : {}),
      });
      response.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      if (upstream.body) for await (const chunk of upstream.body) if (!response.write(chunk)) await once(response, "drain", { signal });
      response.end(); return;
    }
    if (request.method !== "POST") throw new Error("Unsupported company operation.");
    const value = bytes.length ? JSON.parse(bytes.toString()) : {};
    if (path === "/company/slack/start") {
      json(response, 200, { ...bootstrap, closing: Boolean(closing),
        admitted: bootstrap.admitted && !closing, cancelling: bootstrap.cancelling || assignment.cancelPending }); return;
    }
    if (path === "/events") { await options.bridge.event(run, value); json(response, 200, {}); return; }
    if (path === "/company/slack/api") {
      const call = object(value);
      if (effectsBlocked && !["auth.test", "chat.stopStream", "chat.update", "chat.delete"].includes(String(call.method))
        && !(call.method === "assistant.threads.setStatus" && object(call.args).status === "")) throw new Error("The Slack thread is closing.");
      json(response, 200, await slack(run, input, call, signal)); return;
    }
    if (path === "/company/wiki") {
      if (effectsBlocked) throw new Error("The Slack thread is closing.");
      json(response, 200, await wiki(run, input, object(value), signal)); return;
    }
    throw new Error("Unsupported company route.");
  }
  server.listen(options.socket);
  await once(server, "listening");
  await chmod(options.socket, 0o600);
  return { async close() {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await Promise.all(writes.values()); await unlink(options.socket);
  } };
}
