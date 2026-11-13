import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { dispatchCommand, ServiceError, type ServiceCommand, type ServiceExpectation, type ServiceMetadata, type ServiceOperations, type ServiceResults } from "./protocol.js";
import type { Chat, ChatSnapshot } from "./chat.js";
import type { AttachmentFile } from "./chat-content.js";

export type ClientConnection = { socket: string; url?: never; headers?: never } |
  { url: string; socket?: never; headers?: Record<string, string> | (() => Promise<Record<string, string>>) };
export type ChatWatch = { closed: Promise<void>; stop(): Promise<void> };
type Request = <C extends ServiceCommand>(command: C, signal?: AbortSignal) => Promise<ServiceResults[C["method"]]>;
type Watch = (id: string, listener: (snapshot: ChatSnapshot) => void | Promise<void>, signal?: AbortSignal) => Promise<ChatWatch>;

/** Conversation operations only. Closing a client never stops its host or its work. */
export class AgentClient {
  private readonly watches = new Set<ChatWatch>();
  private closed = false;
  constructor(private readonly request: Request, private readonly observe: Watch) {}
  command<C extends ServiceCommand>(command: C, signal?: AbortSignal) {
    if (this.closed) return Promise.reject(new Error("Client is closed."));
    return this.request(command, signal);
  }
  info() { return this.command({ method: "info" }); }
  agents() { return this.command({ method: "agents" }); }
  list() { return this.command({ method: "chats" }); }
  find(agent: string | undefined, key: string) { return this.command({ method: "find", agent, key }); }
  create(agent: string, source: string, key: string, title?: string, origin?: Chat["origin"]) {
    return this.command({ method: "create", agent, source, key, title, origin });
  }
  submit(id: string, text: string, requestId: string, mode: "followUp" | "steer" = "steer", source = "cli", files?: AttachmentFile[]) {
    return this.command({ method: "send", id, text, requestId, mode, source, files });
  }
  snapshot(id: string) { return this.command({ method: "snapshot", id }); }
  receipt(id: string, submissionId: number) { return this.command({ method: "receipt", id, submissionId }); }
  stop(id: string) { return this.command({ method: "stop", id }); }
  async artifact(id: string, artifactId: string) {
    const value = await this.command({ method: "artifact", id, artifactId });
    return { artifact: value.artifact, bytes: Buffer.from(value.dataBase64, "base64") };
  }
  async watch(id: string, listener: (snapshot: ChatSnapshot) => void | Promise<void>, signal?: AbortSignal): Promise<ChatWatch> {
    if (this.closed) throw new Error("Client is closed.");
    const watch = await this.observe(id, listener, signal);
    if (this.closed) { await watch.stop(); throw new Error("Client is closed."); }
    this.watches.add(watch);
    void watch.closed.then(() => this.watches.delete(watch), () => this.watches.delete(watch));
    return watch;
  }
  wait(id: string, submissionId: number, signal?: AbortSignal) {
    return this.command({ method: "wait", id, submissionId }, signal);
  }
  async close() { this.closed = true; await Promise.all([...this.watches].map(watch => watch.stop())); }
}

/** The embedded client uses exactly the same command contract as a socket/HTTP client. */
export function localClient(service: ServiceOperations, metadata: ServiceMetadata = {}, isAdapterBusy: () => Promise<boolean> = async () => false): AgentClient {
  const request: Request = async <C extends ServiceCommand>(command: C, signal?: AbortSignal): Promise<ServiceResults[C["method"]]> => {
    if (command.method === "info") return metadata as ServiceResults[C["method"]];
    if (command.method === "status") {
      if (!service.activity) throw new ServiceError("This host does not expose activity.", 409);
      const [activity, adapterBusy] = await Promise.all([service.activity(), isAdapterBusy()]);
      return { ...activity, adapterBusy, busy: activity.busy || adapterBusy } as ServiceResults[C["method"]];
    }
    return await dispatchCommand(service, command, signal) as ServiceResults[C["method"]];
  };
  return new AgentClient(request, async (id, listener, signal) => {
    signal?.throwIfAborted();
    const watch = await service.watch(id, async value => { await listener(value); });
    const abort = () => { void watch.stop().catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) await watch.stop();
    const closed = watch.closed.then(() => { signal?.throwIfAborted(); }).finally(() => signal?.removeEventListener("abort", abort));
    return { closed, stop: () => watch.stop() };
  });
}

async function endpoint(connection: ClientConnection, path: string, signal?: AbortSignal) {
  if (connection.socket) return { send: httpRequest, options: { socketPath: connection.socket, path, method: "POST", signal,
    headers: { "content-type": "application/json" } } satisfies RequestOptions };
  const url = new URL(connection.url!);
  if (url.username || url.password || url.search || url.hash) throw new Error("Use an agent service origin without embedded credentials, query or fragment.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname)))
    throw new Error("Network clients require HTTPS; HTTP is supported only on loopback.");
  const headers = typeof connection.headers === "function" ? await connection.headers() : connection.headers;
  return { send: url.protocol === "https:" ? httpsRequest : httpRequest, options: {
    protocol: url.protocol, hostname: url.hostname.replace(/^\[|\]$/g, ""), port: url.port,
    path: url.pathname.replace(/\/$/, "") + path, method: "POST", signal, headers: { ...headers, "content-type": "application/json" },
  } satisfies RequestOptions };
}

/** One attempt; an uncertain command is never automatically resent. */
export async function serviceRequest<C extends ServiceCommand>(target: string | ClientConnection, command: C,
  options: { signal?: AbortSignal; expected?: ServiceExpectation } = {}): Promise<ServiceResults[C["method"]]> {
  const { send, options: requestOptions } = await endpoint(typeof target === "string" ? { socket: target } : target, "/v1/commands", options.signal);
  return new Promise((accept, reject) => {
    const outgoing = send(requestOptions, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        try {
          const value = JSON.parse(Buffer.concat(chunks).toString());
          if (response.statusCode !== 200 || value.error) reject(new ServiceError(value.error ?? "Agent service request failed.", response.statusCode ?? 500));
          else accept(value.result);
        } catch (error) { reject(error); }
      });
    });
    outgoing.on("error", reject);
    outgoing.end(JSON.stringify({ command, expected: options.expected }));
  });
}

async function watchService(connection: ClientConnection, expected: ServiceExpectation, id: string,
  listener: (snapshot: ChatSnapshot) => void | Promise<void>, signal?: AbortSignal): Promise<ChatWatch> {
  const { send, options } = await endpoint(connection, "/v1/watch", signal);
  let stopRequested = false, started = false, settled = false;
  let ready!: (watch: ChatWatch) => void, rejectReady!: (error: unknown) => void;
  let finish!: () => void, fail!: (error: unknown) => void;
  const initial = new Promise<ChatWatch>((resolve, reject) => { ready = resolve; rejectReady = reject; });
  const closed = new Promise<void>((resolve, reject) => { finish = resolve; fail = reject; });
  // The initial request can fail before its caller receives the watch.
  void closed.catch(() => {});
  const end = (error?: unknown) => {
    if (settled) return;
    settled = true;
    if (!started) rejectReady(error ?? new Error("Agent stream ended before its initial snapshot."));
    if (error && !stopRequested) fail(error); else finish();
  };
  let reading: Promise<void> | undefined;
  let incoming: import("node:http").IncomingMessage | undefined;
  const outgoing = send(options, response => {
    incoming = response;
    reading = (async () => {
      let buffered = "";
      response.setEncoding("utf8");
      if (response.statusCode !== 200) {
        for await (const chunk of response) buffered += chunk;
        throw new ServiceError(JSON.parse(buffered).error ?? "Agent stream failed.", response.statusCode ?? 500);
      }
      for await (const chunk of response) {
        buffered += chunk;
        let newline;
        while ((newline = buffered.indexOf("\n")) >= 0) {
          const line = buffered.slice(0, newline); buffered = buffered.slice(newline + 1);
          if (!line) continue;
          const value = JSON.parse(line);
          if (value.error) throw new ServiceError(value.error, 500);
          if (!stopRequested) await listener(value.snapshot);
          if (!started) { started = true; ready(watch); }
        }
      }
      if (buffered.trim()) throw new Error("Agent stream ended with an incomplete frame.");
      end();
    })().catch(end);
  });
  const watch: ChatWatch = { closed, stop: async () => {
    stopRequested = true; outgoing.destroy(); incoming?.destroy();
    await reading; end(); await closed.catch(() => {});
  } };
  outgoing.on("error", end);
  outgoing.end(JSON.stringify({ id, expected }));
  return initial;
}

/** Bind a connection to an owner's stable identity. Reconnect deliberately after transport loss. */
export async function connectClient(connection: ClientConnection & { expected?: ServiceExpectation }, signal?: AbortSignal): Promise<AgentClient> {
  const info = await serviceRequest(connection, { method: "info" }, { expected: connection.expected, signal });
  const expected = connection.expected ?? (info.identity !== undefined ? { identity: info.identity }
    : info.stateRoot !== undefined ? { stateRoot: info.stateRoot } : undefined);
  if (!expected) throw new Error("The host must expose a stable stateRoot or identity.");
  return new AgentClient((command, signal) => serviceRequest(connection, command, { expected, signal }),
    (id, listener, signal) => watchService(connection, expected, id, listener, signal));
}

export { ServiceError } from "./protocol.js";
export type { ServiceCommand, ServiceResults, ServiceExpectation, ServiceMetadata } from "./protocol.js";

export { readClientConnection } from "./host-config.js";
