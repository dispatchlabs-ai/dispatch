import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type SlackBrokerEvent = { channelId: string; ts: string; [key: string]: unknown };
export type SlackBrokerGap = { id: string; oldest: string; latest: string };
export type SlackBrokerJournal = { id: string; coverageStart: string; sequence: number; gaps: SlackBrokerGap[] };
export type SlackBrokerState = "starting" | "connected" | "disconnected" | "stopping" | "error";
export type SlackBrokerEventEnvelope = { type: "event"; sequence: number; journalId: string; event: SlackBrokerEvent };
export type SlackBrokerTransportEnvelope = { type: "transport"; state: SlackBrokerState; journal: SlackBrokerJournal };
export type SlackBrokerSubscription = { subscriptionId: string; state: SlackBrokerState; journal: SlackBrokerJournal };
export type SlackBrokerDelivery = { envelopeId?: string; eventId?: string; retryNumber?: number; retryReason?: string; receivedAt: string };
export type SlackBrokerUpstream = {
  on(event: string, handler: (...args: any[]) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<unknown>;
};
export type SlackBrokerOptions = {
  accountId: string; teamId: string; channels: readonly string[];
  stateDirectory: string; socketPath: string; ownershipSocket: string;
  upstream: SlackBrokerUpstream;
  normalizeMessage(channelId: string, value: unknown): SlackBrokerEvent | undefined;
  download(file: Record<string, unknown>): Promise<unknown>;
  /** Required when creating a journal: the last known handover coverage bound. */
  handoverAfter?: string;
  now?: () => string;
  /** The broker has closed; the host should restart it or exit unsuccessfully. */
  onFatal(message: string): void;
};
type Envelope = { type?: string; body?: unknown; team_id?: string; envelope_id?: string; retry_num?: number; retry_reason?: string; ack?: () => Promise<unknown> };
const timestamp = /^\d+\.\d+$/;
const nowTimestamp = () => (Date.now() / 1_000).toFixed(6);
const object = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function compareTimestamps(a: string, b: string) {
  if (!timestamp.test(a) || !timestamp.test(b)) throw new Error("Invalid broker coverage timestamp.");
  const [secondsA, fractionA] = a.split("."), [secondsB, fractionB] = b.split(".");
  const first = BigInt(secondsA), second = BigInt(secondsB);
  if (first !== second) return first < second ? -1 : 1;
  const length = Math.max(fractionA.length, fractionB.length);
  return fractionA.padEnd(length, "0").localeCompare(fractionB.padEnd(length, "0"));
}

/** One account-wide receipt precedes the upstream acknowledgement and every IPC delivery. */
export class SlackEventJournal {
  readonly database: DatabaseSync;
  readonly id: string;
  constructor(directory: string, account: string, team: string, handoverAfter?: string, now = nowTimestamp()) {
    if (!timestamp.test(now) || handoverAfter !== undefined && compareTimestamps(handoverAfter, now) > 0)
      throw new Error("Broker handover coverage must not start in the future.");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(join(directory, "events.sqlite"));
    try {
      this.database.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(sequence INTEGER PRIMARY KEY AUTOINCREMENT,channel TEXT NOT NULL,ts TEXT NOT NULL,event TEXT NOT NULL,UNIQUE(channel,ts));
      CREATE INDEX IF NOT EXISTS channel_sequence ON events(channel,sequence);
      CREATE TABLE IF NOT EXISTS deliveries(id INTEGER PRIMARY KEY AUTOINCREMENT,sequence INTEGER NOT NULL,envelope_id TEXT UNIQUE,event_id TEXT,retry_number INTEGER,retry_reason TEXT,received_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS gaps(id INTEGER PRIMARY KEY AUTOINCREMENT,oldest TEXT NOT NULL,latest TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS one_open_gap ON gaps((1)) WHERE latest IS NULL;`);
      this.transaction(() => {
        if (!this.get("id")) {
          if (handoverAfter === undefined) throw new Error("A new broker journal requires an explicit handover coverage timestamp.");
          this.set("id", randomUUID()); this.set("account", account); this.set("team", team);
          this.set("coverageStart", handoverAfter);
        }
        if (this.get("account") !== account || this.get("team") !== team) throw new Error("Broker journal belongs to another Slack account.");
        const coverageStart = this.get("coverageStart")!, connectionStart = this.get("connectionStart");
        if (compareTimestamps(coverageStart, now) > 0 || connectionStart &&
            (compareTimestamps(connectionStart, coverageStart) < 0 || compareTimestamps(connectionStart, now) > 0))
          throw new Error("Broker coverage bounds do not match the current clock.");
        // A restart is an upstream gap even if the last process never observed a
        // disconnect. Repeated failed starts preserve the original open interval.
        this.openGap(); this.set("connected", "false");
      });
      this.id = this.get("id")!;
    } catch (error) { this.database.close(); throw error; }
  }
  private get(key: string) { return (this.database.prepare("SELECT value FROM metadata WHERE key=?").get(key) as { value: string } | undefined)?.value; }
  private set(key: string, value: string) { this.database.prepare("INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)").run(key, value); }
  private transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.database.exec("COMMIT"); return result; }
    catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }
  private openGap() {
    if (!this.database.prepare("SELECT 1 FROM gaps WHERE latest IS NULL").get())
      this.database.prepare("INSERT INTO gaps(oldest) VALUES(?)").run(this.get("connectionStart") ?? this.get("coverageStart")!);
  }
  disconnected() {
    this.transaction(() => { this.openGap(); this.set("connected", "false"); });
  }
  connected(now = nowTimestamp()) {
    if (!timestamp.test(now)) throw new Error("Invalid broker connection timestamp.");
    this.transaction(() => {
      if (this.get("connected") === "true") return;
      const gap = this.database.prepare("SELECT oldest FROM gaps WHERE latest IS NULL").get() as { oldest: string } | undefined;
      if (!gap || compareTimestamps(gap.oldest, this.get("coverageStart")!) < 0 || compareTimestamps(gap.oldest, now) > 0)
        throw new Error("Broker recovery cannot close invalid coverage bounds.");
      this.database.prepare("UPDATE gaps SET latest=? WHERE latest IS NULL").run(now);
      this.set("connectionStart", now); this.set("connected", "true");
    });
  }
  metadata(): SlackBrokerJournal {
    const sequence = (this.database.prepare("SELECT coalesce(max(sequence),0) AS sequence FROM events").get() as { sequence: number }).sequence;
    if (!Number.isSafeInteger(sequence)) throw new Error("Broker sequence exceeds the supported integer range.");
    const gaps = this.database.prepare("SELECT CAST(id AS TEXT) AS id,oldest,latest FROM gaps WHERE latest IS NOT NULL ORDER BY id").all().map(row =>
      ({ id: row.id as string, oldest: row.oldest as string, latest: row.latest as string }));
    return { id: this.id, coverageStart: this.get("coverageStart")!, sequence, gaps };
  }
  append(event: SlackBrokerEvent, delivery: SlackBrokerDelivery) {
    return this.transaction(() => {
      const prior = this.database.prepare("SELECT sequence FROM events WHERE channel=? AND ts=?").get(event.channelId, event.ts) as { sequence: number } | undefined;
      const sequence = prior?.sequence ?? Number(this.database.prepare("INSERT INTO events(channel,ts,event) VALUES(?,?,?)")
        .run(event.channelId, event.ts, JSON.stringify(event)).lastInsertRowid);
      if (!Number.isSafeInteger(sequence)) throw new Error("Broker sequence exceeds the supported integer range.");
      const recorded = delivery.envelopeId ? this.database.prepare("SELECT sequence FROM deliveries WHERE envelope_id=?").get(delivery.envelopeId) as { sequence: number } | undefined : undefined;
      if (recorded && recorded.sequence !== sequence) throw new Error("Slack envelope identity refers to another message.");
      if (!recorded) this.database.prepare("INSERT INTO deliveries(sequence,envelope_id,event_id,retry_number,retry_reason,received_at) VALUES(?,?,?,?,?,?)")
        .run(sequence, delivery.envelopeId ?? null, delivery.eventId ?? null, delivery.retryNumber ?? null, delivery.retryReason ?? null, delivery.receivedAt);
      return { sequence, inserted: !prior };
    });
  }
  replay(channel: string, after: number, visit: (sequence: number, event: SlackBrokerEvent) => boolean | void) {
    for (const row of this.database.prepare("SELECT sequence,event FROM events WHERE channel=? AND sequence>? ORDER BY sequence").iterate(channel, after))
      if (visit(row.sequence as number, JSON.parse(row.event as string) as SlackBrokerEvent) === false) break;
  }
  close() { this.database.close(); }
}

function listen(server: Server, path: string) {
  return new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => { server.off("error", reject); resolve(); });
  });
}
async function closeServer(server: Server) {
  if (server.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
export class SlackSocketBroker {
  readonly options: SlackBrokerOptions;
  readonly generation = randomUUID().replaceAll("-", "").slice(0, 16);
  readonly startedAt = new Date().toISOString();
  private journal?: SlackEventJournal;
  private ownership = createServer(socket => socket.destroy());
  private ipc = createServer(socket => this.connection(socket));
  private sockets = new Set<Socket>();
  private subscriptions = new Map<Socket, Set<string>>();
  private socketIdentity?: { dev: number; ino: number };
  private state: SlackBrokerState = "starting";
  private lastError?: string;
  private stopping = false;
  private closing?: Promise<void>;
  private statusTimer?: NodeJS.Timeout;
  private statusWrites = Promise.resolve();
  constructor(options: SlackBrokerOptions) { this.options = options; }
  private now() { return this.options.now?.() ?? nowTimestamp(); }
  status() {
    return { accountId: this.options.accountId, pid: process.pid, socketPath: this.options.socketPath,
      generation: this.generation, state: this.state, startedAt: this.startedAt, updatedAt: new Date().toISOString(),
      teamId: this.options.teamId, subscriberCount: this.subscriptions.size, lastError: this.lastError,
      journal: this.journal!.metadata() };
  }
  async start() {
    const { upstream } = this.options;
    // Acquire the host's exclusive ownership lock before touching its endpoint
    // or journal. Never unlink another live owner's socket.
    await listen(this.ownership, this.options.ownershipSocket);
    try {
      this.journal = new SlackEventJournal(this.options.stateDirectory, this.options.accountId, this.options.teamId, this.options.handoverAfter, this.now());
      await chmod(join(this.options.stateDirectory, "events.sqlite"), 0o600);
      await mkdir(dirname(this.options.socketPath), { recursive: true, mode: 0o700 });
      const previous = await lstat(this.options.socketPath).catch(error => { if (error.code === "ENOENT") return; throw error; });
      if (previous) {
        if (!previous.isSocket() && !previous.isSymbolicLink()) throw new Error("Preserving a non-socket broker endpoint.");
        await unlink(this.options.socketPath);
      }
      await listen(this.ipc, this.options.socketPath);
      await chmod(this.options.socketPath, 0o600);
      const identity = await lstat(this.options.socketPath); this.socketIdentity = { dev: identity.dev, ino: identity.ino };
      upstream.on("connected", () => this.upstreamConnected());
      for (const event of ["close", "reconnecting", "disconnecting", "disconnected"])
        upstream.on(event, () => this.upstreamDisconnected());
      upstream.on("error", () => this.fail("Slack transport failed; restart the upstream connection."));
      upstream.on("slack_event", (envelope: Envelope) => this.envelope(envelope));
      this.ownership.on("error", () => this.fail("Broker ownership socket failed."));
      this.ipc.on("error", () => this.fail("Broker IPC socket failed."));
      await this.writeStatus();
      this.statusTimer = setInterval(() => { void this.writeStatus().catch(() => this.fail("Broker status could not be saved.")); }, 5_000);
      try { await upstream.start(); }
      catch { throw new Error("Slack upstream could not start."); }
      return this;
    } catch (error) { await this.close().catch(() => {}); throw error; }
  }
  private upstreamConnected() {
    if (this.stopping || this.state === "connected") return;
    try {
      // This listener is synchronous: the closed gap reaches every subscriber
      // before the SDK can emit any subsequent post-hello message envelope.
      this.journal!.connected(this.now()); this.state = "connected"; this.lastError = undefined;
      this.transport(); void this.writeStatus().catch(() => this.fail("Broker status could not be saved."));
    } catch { this.fail("Broker could not persist upstream recovery."); }
  }
  private upstreamDisconnected() {
    if (this.stopping || this.state === "disconnected") return;
    try {
      this.journal!.disconnected(); this.state = "disconnected";
      this.transport(); void this.writeStatus().catch(() => this.fail("Broker status could not be saved."));
    } catch { this.fail("Broker could not persist its upstream gap."); }
  }
  private envelope(envelope: Envelope) {
    if (this.stopping) return;
    try {
      const body = object(envelope.body), raw = object(body?.event);
      if (envelope.type === "events_api" && raw && ["message", "app_mention"].includes(String(raw.type))
          && typeof raw.channel === "string" && this.options.channels.includes(raw.channel)) {
        const teams = [envelope.team_id, body?.team_id].filter(value => value !== undefined);
        if (!teams.length || teams.some(team => team !== this.options.teamId)) throw new Error("Slack workspace identity does not match this broker.");
        const event = this.options.normalizeMessage(raw.channel, raw);
        if (event) {
          if (event.channelId !== raw.channel || !timestamp.test(event.ts)) throw new Error("Invalid normalized Slack event identity.");
          const receipt = this.journal!.append(event, {
            ...(typeof envelope.envelope_id === "string" ? { envelopeId: envelope.envelope_id } : {}),
            ...(typeof body?.event_id === "string" ? { eventId: body.event_id } : {}),
            ...(Number.isSafeInteger(envelope.retry_num) ? { retryNumber: envelope.retry_num } : {}),
            ...(typeof envelope.retry_reason === "string" ? { retryReason: envelope.retry_reason } : {}),
            receivedAt: this.now(),
          });
          if (receipt.inserted) for (const [socket, channels] of this.subscriptions)
            if (channels.has(event.channelId)) this.event(socket, receipt.sequence, event);
        }
      }
    } catch { this.fail("Broker could not durably record a Slack event; it was not acknowledged."); return; }
    // Even duplicates are acknowledged only after their durable receipt exists.
    try { void envelope.ack?.().catch(() => this.fail("Slack acknowledgement failed; restart the upstream connection.")); }
    catch { this.fail("Slack acknowledgement failed; restart the upstream connection."); }
  }
  private event(socket: Socket, sequence: number, event: SlackBrokerEvent) {
    return this.send(socket, { type: "event", sequence, journalId: this.journal!.id, event }, true);
  }
  private transport() {
    const message = { type: "transport", state: this.state, journal: this.journal!.metadata() };
    for (const socket of this.subscriptions.keys()) this.send(socket, message);
  }
  private send(socket: Socket, value: unknown, replayable = false) {
    // A dead or slow IPC reader never changes the durable receipt or Slack ACK.
    // Its next subscription replays the journal from its own committed cursor.
    if (socket.destroyed || socket.writableEnded) return false;
    try {
      // Let one large control frame drain without forcing a reconnect loop.
      // A further write while blocked ends this subscription before adding bytes.
      if (!socket.writableNeedDrain && (socket.write(JSON.stringify(value) + "\n") || !replayable)) return true;
      // Flush the accepted bytes before ending: destroying immediately could
      // prevent an event larger than the stream buffer from ever being received.
      this.subscriptions.delete(socket); socket.end();
    } catch { socket.destroy(); this.subscriptions.delete(socket); }
    return false;
  }
  private connection(socket: Socket) {
    if (this.stopping) { socket.destroy(); return; }
    this.sockets.add(socket); socket.setEncoding("utf8"); let buffer = "";
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n"); if (newline < 0) break;
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        if (line.trim()) void this.request(socket, line);
      }
    });
    const cleanup = () => { this.sockets.delete(socket); this.subscriptions.delete(socket); };
    socket.on("close", cleanup); socket.on("error", cleanup);
  }
  private async request(socket: Socket, line: string) {
    let id: unknown;
    try {
      const request = object(JSON.parse(line));
      id = request?.id;
      if (!request || typeof id !== "string") throw new Error("A broker request needs a string ID.");
      let result: unknown;
      switch (request.type) {
        case "status": result = this.status(); break;
        case "subscribe": {
          const channel = request.channelId, journal = this.journal!.metadata(), after = request.afterSequence ?? 0;
          if (typeof channel !== "string" || !this.options.channels.includes(channel)) throw new Error("Unknown broker channel.");
          if (request.journalId !== undefined && request.journalId !== journal.id) throw new Error("Broker journal identity changed; reconcile before resubscribing.");
          if (typeof after !== "number" || !Number.isSafeInteger(after) || after < 0 || after > journal.sequence)
            throw new Error("Broker replay cursor is out of range.");
          if (after > 0 && request.journalId !== journal.id) throw new Error("Resuming a broker cursor requires its journal identity.");
          const channels = this.subscriptions.get(socket) ?? new Set<string>(); channels.add(channel); this.subscriptions.set(socket, channels);
          // No await: ordered replay and its success response are queued before
          // live SDK callbacks can interleave on this event loop.
          this.journal!.replay(channel, after, (sequence, event) => this.event(socket, sequence, event));
          result = { subscriptionId: channel, state: this.state, journal }; break;
        }
        case "unsubscribe": {
          const channels = this.subscriptions.get(socket), removed = channels?.delete(String(request.subscriptionId));
          if (!channels?.size) this.subscriptions.delete(socket);
          result = { unsubscribed: !!removed }; break;
        }
        case "download": {
          const file = object(request.file);
          if (!file) throw new Error("A Slack file reference is required.");
          result = await this.options.download(file); break;
        }
        default: throw new Error("Unsupported broker RPC.");
      }
      this.send(socket, { id, ok: true, result });
    } catch (error) { this.send(socket, { id: typeof id === "string" ? id : "parse-error", ok: false, error: error instanceof Error ? error.message : "Invalid broker request." }); }
  }
  private writeStatus() {
    const write = this.statusWrites.then(async () => {
      if (!this.journal || !this.ownership.listening) return;
      const path = join(dirname(this.options.socketPath), "broker.json"), temporary = `${path}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, JSON.stringify(this.status()) + "\n", { mode: 0o600 }); await rename(temporary, path); }
      finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    });
    this.statusWrites = write.catch(() => {}); return write;
  }
  private fail(message: string) {
    if (this.stopping) return;
    this.lastError = message; this.state = "error";
    for (const socket of this.sockets) socket.destroy();
    void this.close().then(() => this.options.onFatal(message), () => this.options.onFatal(message));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.stopping = true;
    return this.closing = (async () => {
      let failure: unknown;
      const attempt = async (operation: () => unknown) => {
        try { await operation(); } catch (error) { failure ??= error; }
      };
      if (this.statusTimer) clearInterval(this.statusTimer);
      await attempt(() => { if (this.journal) {
        this.journal.disconnected(); this.state = "stopping"; this.transport();
      } });
      for (const socket of this.sockets) socket.destroy();
      await Promise.all([attempt(() => this.options.upstream.disconnect()), attempt(() => closeServer(this.ipc))]);
      await attempt(() => this.writeStatus()); await this.statusWrites;
      await attempt(async () => {
        const path = this.options.socketPath;
        const current = await lstat(path).catch(error => { if (error.code !== "ENOENT") throw error; });
        if (this.socketIdentity && current?.dev === this.socketIdentity.dev && current?.ino === this.socketIdentity.ino) await unlink(path);
      });
      await attempt(() => this.journal?.close()); this.journal = undefined;
      await attempt(() => closeServer(this.ownership));
      if (failure) throw failure;
    })();
  }
}
