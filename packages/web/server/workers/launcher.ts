import { createHash } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import { acquireRuntimeOwner } from "../runtime-owner.js";
import { PostgresLauncherJournal } from "./postgres-launcher-journal.js";

const identity = z.string().min(1).max(200).refine(value => !value.includes("\0"));
export const launchRequestSchema = z.object({
  attemptId: identity, conversationId: identity, storeId: identity, configurationRevision: identity,
}).strict();
export type LaunchRequest = z.infer<typeof launchRequestSchema>;

export type ContainerSpec = LaunchRequest & { installationId: string; name: string };
const containerSchema = launchRequestSchema.extend({
  id: identity, name: identity, installationId: identity,
  state: z.enum(["created", "running", "exited", "unknown"]),
}).strict();
export type LauncherContainer = z.infer<typeof containerSchema>;

/** Trusted transport boundary. Requests cannot supply images, mounts, commands or privileges.
 *
 * list must return the COMPLETE installation inventory, including stopped containers, or throw.
 * create is idempotent by spec.name and creates only a stopped container, with no restart policy.
 * Labels retain the entire spec identity; changed inputs or disallowed configuration revisions conflict.
 * start addresses an immutable ID, never a name; IDs are never reused.
 * retire disables restart, stops/removes that immutable ID and confirms termination/removal.
 * A retired ID must never execute, even if an earlier start request arrives late. In Docker this
 * requires removal, not just StopContainer. Missing IDs are successful retire retries.
 * Transport calls must have bounded deadlines. Unknown outcomes throw; a timeout is never evidence
 * that an effect did not happen. Driver list results must be fresh, never a cached desired state.
 */
export interface ContainerDriver {
  list(installationId: string): Promise<LauncherContainer[]>;
  create(spec: ContainerSpec): Promise<void>;
  start(containerId: string): Promise<void>;
  retire(containerId: string): Promise<void>;
}

const attemptSchema = launchRequestSchema.extend({
  name: identity, containerId: identity.optional(),
  phase: z.enum(["creating", "starting", "running", "stopping", "stopped"]),
});
export type LaunchAttempt = z.infer<typeof attemptSchema>;
const journalSchema = z.object({
  version: z.literal(1), installationId: identity, drained: z.boolean(), attempts: z.array(attemptSchema),
  stoppedAttemptIds: z.array(identity),
}).strict();
type Journal = z.infer<typeof journalSchema>;

interface LauncherJournal {
  assertHealthy(): void;
  save(body: string): Promise<void>;
  close(): Promise<void>;
}

export type LauncherStatus = {
  installationId: string;
  drained: boolean;
  driverReachable: boolean;
  drainComplete: boolean;
  activeWorkers: LauncherContainer[];
  containers: LauncherContainer[];
  attempts: Array<LaunchAttempt & { observed: LauncherContainer["state"] | "absent" | "unknown" }>;
  unresolvedAttempts: string[];
  orphanContainerIds: string[];
};

export class LauncherError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

/** Single-host lifecycle owner. Pi tasks and conversation data never enter this journal.
 * HTTP authorization belongs to the caller; keep this directory private and persistent.
 */
export class WorkerLauncher {
  private tail: Promise<unknown> = Promise.resolve();
  private closing = false;
  private closePromise?: Promise<void>;
  private poisoned = false;

  private constructor(
    private readonly storage: LauncherJournal,
    private readonly driver: ContainerDriver,
    private journal: Journal,
  ) {}

  static async open(options: { stateDir: string; installationId: string; driver: ContainerDriver }) {
    identity.parse(options.installationId);
    const owner = await acquireRuntimeOwner(options.stateDir);
    let db: DatabaseSync | undefined;
    try {
      const filename = join(owner.directory, "launcher.sqlite");
      db = new DatabaseSync(filename);
      await chmod(filename, 0o600);
      db.exec("PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY CHECK (id = 1), body TEXT NOT NULL)");
      const row = db.prepare("SELECT body FROM journal WHERE id = 1").get();
      const journal = row ? parseJournal(String(row.body), options.installationId) : {
        version: 1 as const, installationId: options.installationId, drained: true, attempts: [], stoppedAttemptIds: [],
      };
      if (!row) db.prepare("INSERT INTO journal (id, body) VALUES (1, ?)").run(JSON.stringify(journal));
      const database = db;
      return new WorkerLauncher({
        assertHealthy() {},
        async save(body) { database.prepare("UPDATE journal SET body = ? WHERE id = 1").run(body); },
        async close() { try { database.close(); } finally { owner.release(); } },
      }, options.driver, journal);
    } catch (error) {
      try { db?.close(); } finally { owner.release(); }
      throw error;
    }
  }

  /** Explicit opt-in; no SQLite import or automatic crashed-controller takeover. */
  static async openPostgres(options: { connectionString: string; installationId: string; driver: ContainerDriver; recoverOwnerId?: string }) {
    identity.parse(options.installationId);
    const initial: Journal = { version: 1, installationId: options.installationId, drained: true, attempts: [], stoppedAttemptIds: [] };
    const storage = await PostgresLauncherJournal.open({ ...options, initial: JSON.stringify(initial) });
    try {
      const journal = parseJournal(storage.initialBody, options.installationId);
      return new WorkerLauncher(storage, options.driver, journal);
    } catch (error) { await storage.close(); throw error; }
  }

  /** A new installation starts drained. Explicitly enable admission after operator verification. */
  undrain(): Promise<LauncherStatus> {
    return this.serial(async () => {
      const status = await this.readStatus();
      if (!this.journal.drained) return status;
      if (!status.drainComplete) throw new LauncherError(409, "Resolve all attempts and containers before enabling admission.");
      await this.save({ ...this.journal, drained: false });
      return this.readStatus();
    });
  }

  ensure(input: LaunchRequest): Promise<LaunchAttempt> {
    const request = launchRequestSchema.parse(input);
    return this.serial(async () => {
      if (this.journal.stoppedAttemptIds.includes(request.attemptId)) throw new LauncherError(409, "Stopped launch attempts cannot be restarted.");
      let attempt = this.journal.attempts.find(item => item.attemptId === request.attemptId);
      if (attempt && !sameRequest(attempt, request)) throw new LauncherError(409, "Launch attempt inputs changed.");
      if (attempt && (attempt.phase === "stopped" || attempt.phase === "stopping"))
        throw new LauncherError(409, "Stopped launch attempts cannot be restarted; reconcile stop before replacement.");
      if (this.journal.drained) throw new LauncherError(409, "Worker admission is drained.");
      if (!attempt) {
        if (this.journal.attempts.some(item => item.phase !== "stopped" && (item.conversationId === request.conversationId || item.storeId === request.storeId)))
          throw new LauncherError(409, "A previous executor attempt must be retired before replacement.");
        const status = await this.readStatus();
        if (!status.driverReachable || status.orphanContainerIds.length)
          throw new LauncherError(503, "Reconcile unresolved launcher state before admitting a new worker.");
        const digest = createHash("sha256").update(JSON.stringify([this.journal.installationId, request.attemptId])).digest("hex");
        attempt = { ...request, name: `dispatch-worker-${digest.slice(0, 40)}`, phase: "creating" };
        await this.save({ ...this.journal, attempts: [...this.journal.attempts, attempt] });
      }
      return this.advance(attempt);
    });
  }

  /** Reconcile this same persisted attempt; never invent a replacement or revive a tombstone. */
  reconcile(attemptId: string): Promise<LaunchAttempt> {
    identity.parse(attemptId);
    return this.serial(async () => {
      const attempt = this.find(attemptId);
      if (attempt.phase === "stopped" || attempt.phase === "stopping" || this.journal.drained) return this.retire(attempt);
      return this.advance(attempt);
    });
  }

  stop(attemptId: string): Promise<{ attemptId: string; phase: "stopped" }> {
    identity.parse(attemptId);
    return this.serial(async () => {
      const attempt = this.journal.attempts.find(item => item.attemptId === attemptId);
      if (attempt) await this.retire(attempt);
      else {
        // Stop can arrive before its delayed ensure request. Even an unknown attempt needs a tombstone.
        if (!this.journal.stoppedAttemptIds.includes(attemptId))
          await this.save({ ...this.journal, stoppedAttemptIds: [...this.journal.stoppedAttemptIds, attemptId] });
        for (const container of (await this.inventory()).filter(item => item.attemptId === attemptId)) { this.storage.assertHealthy(); await this.driver.retire(container.id); }
        if ((await this.inventory()).some(item => item.attemptId === attemptId)) throw new LauncherError(503, "Container retirement is unresolved.");
      }
      return { attemptId, phase: "stopped" };
    });
  }

  /** Seal admission durably BEFORE enumerating/stopping; failure leaves the installation drained. */
  drain(): Promise<LauncherStatus> {
    return this.serial(async () => {
      // Persist the admission seal and every stop intent before transport effects.
      await this.save({ ...this.journal, drained: true, attempts: this.journal.attempts.map(attempt => attempt.phase === "stopped" ? attempt : { ...attempt, phase: "stopping" }) });
      for (const attempt of this.journal.attempts) {
        try { await this.retire(attempt); }
        catch { if (this.poisoned) throw new LauncherError(503, "Launcher journal failed; reopen before continuing."); }
      }
      // Include orphan containers after a lost journal/restore; never adopt them as runnable attempts.
      try {
        for (const container of await this.inventory()) { this.storage.assertHealthy(); await this.driver.retire(container.id); }
      } catch { /* readStatus reports unreachable/unresolved state; never report a successful drain here. */ }
      return this.readStatus();
    });
  }

  status(): Promise<LauncherStatus> { return this.serial(() => this.readStatus()); }

  /** Close the controller only. Workers survive; callers must explicitly drain for a stack shutdown. */
  close(): Promise<void> {
    if (!this.closePromise) {
      this.closing = true;
      this.closePromise = this.tail.then(() => this.storage.close());
    }
    return this.closePromise;
  }

  private async advance(attempt: LaunchAttempt): Promise<LaunchAttempt> {
    let containers = await this.inventory();
    let container = this.match(attempt, containers);
    if (attempt.containerId && !container) throw new LauncherError(409, "Previously created container is absent; retire the attempt before replacement.");
    if (!container) {
      this.storage.assertHealthy();
      await this.driver.create({ ...pickRequest(attempt), installationId: this.journal.installationId, name: attempt.name });
      containers = await this.inventory();
      container = this.match(attempt, containers);
      if (!container) throw new LauncherError(503, "Container creation is unresolved; reconcile the same attempt.");
    }
    if (!attempt.containerId) {
      attempt = { ...attempt, containerId: container.id };
      await this.update(attempt);
    }
    if (container.state === "unknown") throw new LauncherError(503, "Container state is unknown.");
    if (container.state === "exited") throw new LauncherError(409, "Exited workers require retirement and a new attempt, not restart.");
    if (container.state === "running" && attempt.phase === "creating") throw new LauncherError(503, "Container ran without a journaled start intent.");
    if (container.state === "created") {
      // Never resend start after an uncertain result: the first request could arrive, finish,
      // and exit before a retry arrives, causing Docker to restart an already-executed worker.
      if (attempt.phase !== "creating") throw new LauncherError(409, "A journaled start is unresolved; retire this attempt before replacement.");
      attempt = { ...attempt, phase: "starting" };
      await this.update(attempt); // Record immutable target before issuing any potentially delayed start.
      this.storage.assertHealthy();
      await this.driver.start(container.id);
      container = this.match(attempt, await this.inventory());
      if (!container || container.state !== "running") throw new LauncherError(503, "Container start is unresolved; reconcile the same attempt.");
    }
    attempt = { ...attempt, phase: "running" };
    await this.update(attempt);
    return structuredClone(attempt);
  }

  private async retire(attempt: LaunchAttempt): Promise<LaunchAttempt> {
    if (attempt.phase !== "stopped" && attempt.phase !== "stopping") {
      attempt = { ...attempt, phase: "stopping" };
      await this.update(attempt);
    }
    // Retirement addresses every matching immutable ID, including a late stopped-only create.
    const containers = await this.inventory();
    const targets = containers.filter(container => container.attemptId === attempt.attemptId || container.name === attempt.name || container.id === attempt.containerId);
    for (const container of targets) { this.storage.assertHealthy(); await this.driver.retire(container.id); }
    // The inventory check is necessary even if a transport reports a successful stop/removal.
    const remaining = await this.inventory();
    if (remaining.some(container => targets.some(target => target.id === container.id) || container.attemptId === attempt.attemptId || container.name === attempt.name))
      throw new LauncherError(503, "Container retirement is unresolved.");
    // A delayed create may still appear, but cannot execute: create never starts containers, and
    // no start is issued until its immutable ID has been journaled. Late starts of retired IDs fail.
    attempt = { ...attempt, phase: "stopped" };
    await this.update(attempt);
    return structuredClone(attempt);
  }

  private async inventory(): Promise<LauncherContainer[]> {
    const containers = z.array(containerSchema).parse(await this.driver.list(this.journal.installationId));
    if (containers.some(container => container.installationId !== this.journal.installationId) || new Set(containers.map(container => container.id)).size !== containers.length)
      throw new LauncherError(503, "Invalid installation container inventory.");
    return containers;
  }

  private match(attempt: LaunchAttempt, containers: LauncherContainer[]): LauncherContainer | undefined {
    const matches = containers.filter(container => container.attemptId === attempt.attemptId || container.name === attempt.name || container.id === attempt.containerId);
    if (matches.length > 1 || matches.some(container => !sameRequest(container, attempt) || container.name !== attempt.name || (attempt.containerId && container.id !== attempt.containerId)))
      throw new LauncherError(503, "Container identity conflict; drain or reconcile retirement.");
    return matches[0];
  }

  private async readStatus(): Promise<LauncherStatus> {
    let containers: LauncherContainer[] = [];
    let driverReachable = true;
    try { containers = await this.inventory(); } catch { driverReachable = false; }
    const unresolved = new Set<string>();
    const attempts = this.journal.attempts.map(attempt => {
      let observed: LauncherStatus["attempts"][number]["observed"] = "unknown";
      if (driverReachable) {
        try { observed = this.match(attempt, containers)?.state ?? "absent"; } catch { /* ambiguous identity */ }
      }
      if (!((attempt.phase === "running" && observed === "running") || (attempt.phase === "stopped" && observed === "absent"))) unresolved.add(attempt.attemptId);
      return { ...attempt, observed };
    });
    const orphanContainerIds = containers.filter(container => !this.journal.attempts.some(attempt => sameRequest(attempt, container) && attempt.name === container.name && (!attempt.containerId || attempt.containerId === container.id))).map(container => container.id);
    return {
      installationId: this.journal.installationId, drained: this.journal.drained, driverReachable,
      drainComplete: this.journal.drained && driverReachable && !containers.length && !unresolved.size && this.journal.attempts.every(attempt => attempt.phase === "stopped"),
      activeWorkers: containers.filter(container => container.state === "running" || container.state === "unknown"),
      containers, attempts, unresolvedAttempts: [...unresolved], orphanContainerIds,
    };
  }

  private find(id: string) {
    const attempt = this.journal.attempts.find(item => item.attemptId === id);
    if (!attempt) throw new LauncherError(404, "Launch attempt not found.");
    return attempt;
  }

  private async update(attempt: LaunchAttempt) {
    await this.save({ ...this.journal, attempts: this.journal.attempts.map(item => item.attemptId === attempt.attemptId ? attempt : item) });
  }

  private async save(journal: Journal) {
    try { await this.storage.save(JSON.stringify(journal)); }
    catch {
      // Even an uncertain local commit must not permit more container effects in this instance.
      this.poisoned = true;
      throw new LauncherError(503, "Launcher journal failed; reopen before continuing.");
    }
    this.journal = journal;
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new LauncherError(503, "Launcher is closing."));
    const result = this.tail.then(() => {
      if (this.poisoned) throw new LauncherError(503, "Launcher journal failed; reopen before continuing.");
      this.storage.assertHealthy();
      return operation();
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}

function pickRequest(request: LaunchRequest): LaunchRequest {
  return { attemptId: request.attemptId, conversationId: request.conversationId, storeId: request.storeId, configurationRevision: request.configurationRevision };
}
function sameRequest(a: LaunchRequest, b: LaunchRequest) { return JSON.stringify(pickRequest(a)) === JSON.stringify(pickRequest(b)); }

function parseJournal(body: string, installationId: string): Journal {
  const journal = journalSchema.parse(JSON.parse(body));
  if (journal.installationId !== installationId) throw new LauncherError(409, "Launcher state belongs to a different installation.");
  if (new Set(journal.attempts.map(attempt => attempt.attemptId)).size !== journal.attempts.length)
    throw new Error("Duplicate attempt IDs in launcher journal.");
  return journal;
}
