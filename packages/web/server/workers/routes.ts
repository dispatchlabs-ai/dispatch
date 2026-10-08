import { randomUUID } from "node:crypto";
import { chmod } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { CreateChatInput, RuntimeScope } from "../../src/shared/contracts.js";
import { acquireRuntimeOwner } from "../runtime-owner.js";
import { storedWorkerSummarySchema, workerSummarySchema, type WorkerSummaryObservation } from "./summaries.js";

const routeSchema = z.object({
  conversationId: z.string().min(1), companyId: z.string().min(1), storeId: z.string().min(1),
  attemptId: z.string().uuid(), configurationRevision: z.string().min(1),
  nativeRoomId: z.string().optional(), containerName: z.string().optional(),
  scope: z.custom<RuntimeScope>(value => typeof value === "object" && value !== null),
  input: z.custom<CreateChatInput>(value => typeof value === "object" && value !== null),
  phase: z.enum(["pending", "ready", "retiring"]),
  summary: storedWorkerSummarySchema.optional(),
}).strict();
export type WorkerRoute = z.infer<typeof routeSchema>;

/** Backend-owned routing journal. Persist intent before launcher effects. A route
 * is not authorization: callers must check current membership before using it.
 */
export class WorkerRoutes {
  // Process-local observation freshness, never an executor lease or fencing proof.
  private readonly summaryReceivedAt = new Map<string, number>();
  private constructor(private readonly db: DatabaseSync, private readonly release: () => void) {}
  static async open(directory: string, installation: string) {
    const owner = await acquireRuntimeOwner(directory);
    let db: DatabaseSync | undefined;
    try {
      const filename = join(owner.directory, "routes.sqlite");
      db = new DatabaseSync(filename); await chmod(filename, 0o600);
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS identity (id INTEGER PRIMARY KEY CHECK(id=1), installation TEXT NOT NULL); CREATE TABLE IF NOT EXISTS routes (conversation TEXT PRIMARY KEY, body TEXT NOT NULL)");
      const row = db.prepare("SELECT installation FROM identity WHERE id=1").get();
      if (row && row.installation !== installation) throw new Error("Routing state belongs to another installation.");
      if (!row) db.prepare("INSERT INTO identity VALUES (1, ?)").run(installation);
      return new WorkerRoutes(db, owner.release);
    } catch (error) { try { db?.close(); } finally { owner.release(); } throw error; }
  }
  admissionBlocked(): boolean {
    this.db.exec("CREATE TABLE IF NOT EXISTS admission (id INTEGER PRIMARY KEY CHECK(id=1), blocked INTEGER NOT NULL); INSERT OR IGNORE INTO admission VALUES (1, 1)");
    return this.db.prepare("SELECT blocked FROM admission WHERE id=1").get()?.blocked !== 0;
  }
  setAdmissionBlocked(blocked: boolean) { this.db.prepare("UPDATE admission SET blocked=? WHERE id=1").run(blocked ? 1 : 0); }
  get(conversationId: string): WorkerRoute | undefined {
    const row = this.db.prepare("SELECT body FROM routes WHERE conversation=?").get(conversationId);
    return row ? routeSchema.parse(JSON.parse(String(row.body))) : undefined;
  }
  list(): WorkerRoute[] {
    return this.db.prepare("SELECT body FROM routes ORDER BY conversation").all().map(row => routeSchema.parse(JSON.parse(String(row.body))));
  }
  ensure(conversationId: string, scope: RuntimeScope, input: CreateChatInput, configurationRevision: string): WorkerRoute {
    const companyId = scope.companyId;
    const existing = this.get(conversationId);
    if (existing) {
      if (existing.companyId !== companyId) throw new Error("Conversation route scope mismatch.");
      return existing;
    }
    const route: WorkerRoute = { conversationId, companyId, scope, input, configurationRevision, storeId: `conversation-${randomUUID()}`, attemptId: randomUUID(), phase: "pending" };
    this.save(route); return route;
  }
  ready(conversationId: string, attemptId: string, nativeRoomId: string, containerName: string) {
    const route = this.requireAttempt(conversationId, attemptId);
    if (route.phase === "retiring") throw new Error("Worker is retiring.");
    if (route.nativeRoomId && route.nativeRoomId !== nativeRoomId) throw new Error("Worker room binding changed.");
    const next = { ...route, nativeRoomId, containerName, phase: "ready" as const };
    this.save(next); return next;
  }
  retiring(conversationId: string, attemptId: string) {
    const route = this.requireAttempt(conversationId, attemptId);
    this.save({ ...route, phase: "retiring" });
  }
  /** Invoke only after fresh launcher evidence confirms irreversible retirement. */
  replaceRetired(conversationId: string, oldAttemptId: string, configurationRevision: string) {
    const route = this.requireAttempt(conversationId, oldAttemptId);
    if (route.phase !== "retiring") throw new Error("Persist retirement intent before replacement.");
    const next: WorkerRoute = { ...route, configurationRevision, attemptId: randomUUID(), phase: "pending" };
    delete next.containerName;
    this.save(next); return next;
  }
  /** Caller authenticates the worker token first. Synchronous validation and save
   * share the routing owner's exclusive lock and cannot interleave replacement. */
  updateSummary(conversationId: string, attemptId: string, storeId: string, input: unknown): void {
    const route = this.requireAttempt(conversationId, attemptId);
    if (route.storeId !== storeId || route.phase === "retiring") throw new Error("Stale worker summary binding.");
    const value = workerSummarySchema.parse(input);
    const previous = route.summary;
    if (previous && value.revision < previous.value.revision) throw new Error("Stale worker summary revision.");
    if (previous && value.revision === previous.value.revision) {
      if (JSON.stringify(value) !== JSON.stringify(previous.value)) throw new Error("Conflicting worker summary revision.");
      if (previous.attemptId === attemptId) {
        this.summaryReceivedAt.set(conversationId, performance.now());
        return;
      }
    }
    this.save({ ...route, summary: { attemptId, value } });
    this.summaryReceivedAt.set(conversationId, performance.now());
  }
  /** Historical observations survive replacement, but are not current liveness. */
  readSummary(conversationId: string): WorkerSummaryObservation | undefined {
    const route = this.get(conversationId);
    if (!route?.summary) return undefined;
    const receivedAt = this.summaryReceivedAt.get(conversationId);
    return { value: route.summary.value, stale: route.phase === "retiring" || route.summary.attemptId !== route.attemptId
      || receivedAt === undefined || performance.now() - receivedAt >= 10_000 };
  }
  close() { try { this.db.close(); } finally { this.release(); } }
  private requireAttempt(conversationId: string, attemptId: string) {
    const route = this.get(conversationId);
    if (!route || route.attemptId !== attemptId) throw new Error("Stale worker attempt.");
    return route;
  }
  private save(route: WorkerRoute) {
    const body = JSON.stringify(routeSchema.parse(route));
    this.db.prepare("INSERT INTO routes VALUES (?, ?) ON CONFLICT(conversation) DO UPDATE SET body=excluded.body").run(route.conversationId, body);
  }
}
