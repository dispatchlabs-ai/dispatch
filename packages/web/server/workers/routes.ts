import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CreateChatInput, RuntimeScope } from "../../src/shared/contracts.js";
import { storedWorkerSummarySchema, workerSummarySchema, type WorkerSummaryObservation } from "./summaries.js";
import { RoutingDatabase, type RoutingPostgresOptions } from "./routing-database.js";

const routeSchema = z.object({
  conversationId: z.string().min(1), companyId: z.string().min(1), storeId: z.string().min(1),
  attemptId: z.string().uuid(), configurationRevision: z.string().min(1),
  nativeRoomId: z.string().optional(), containerName: z.string().optional(),
  scope: z.custom<RuntimeScope>(value => typeof value === "object" && value !== null),
  input: z.custom<CreateChatInput>(value => typeof value === "object" && value !== null),
  phase: z.enum(["pending", "ready", "retiring", "sleeping"]),
  idleTimeoutSupported: z.boolean().optional(),
  idleRetirement: z.object({ minimumIdleMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict().optional(),
  summary: storedWorkerSummarySchema.optional(),
}).strict();
export type WorkerRoute = z.infer<typeof routeSchema>;

/** Backend-owned routing journal. Await committed intent before launcher effects.
 * A route is not authorization: callers must check current membership before use.
 */
export class WorkerRoutes {
  // Process-local observation freshness, never an executor lease or fencing proof.
  private readonly summaryReceivedAt = new Map<string, number>();
  private constructor(private readonly db: RoutingDatabase) {}
  static async open(directory: string, installation: string) {
    return WorkerRoutes.fromDatabase(await RoutingDatabase.openSqlite(directory, installation));
  }
  static async openPostgres(options: RoutingPostgresOptions) {
    return WorkerRoutes.fromDatabase(await RoutingDatabase.openPostgres(options));
  }
  private static async fromDatabase(db: RoutingDatabase) {
    const routes = new WorkerRoutes(db);
    try { routes.list(); return routes; }
    catch (error) { await db.close(); throw error; }
  }
  get ownerId() { return this.db.ownerId; }
  admissionBlocked(): boolean { return this.db.admissionBlocked(); }
  setAdmissionBlocked(blocked: boolean): Promise<void> {
    return this.db.change(undefined, () => ({ blocked, result: undefined }));
  }
  get(conversationId: string): WorkerRoute | undefined {
    const body = this.db.row(conversationId);
    return body === undefined ? undefined : this.decode(conversationId, body);
  }
  list(): WorkerRoute[] { return this.db.list().map(([id, body]) => this.decode(id, body)); }
  ensure(conversationId: string, scope: RuntimeScope, input: CreateChatInput, configurationRevision: string): Promise<WorkerRoute> {
    // Snapshot caller-owned input before asynchronous queue admission.
    const proposed = JSON.stringify({ conversationId, companyId: scope.companyId, scope, input, configurationRevision,
      storeId: `conversation-${randomUUID()}`, attemptId: randomUUID(), phase: "pending" });
    const companyId = scope.companyId;
    return this.change(conversationId, existing => {
      if (existing) {
        if (existing.companyId !== companyId) throw new Error("Conversation route scope mismatch.");
        return existing;
      }
      return this.decode(conversationId, proposed);
    });
  }
  ready(conversationId: string, attemptId: string, nativeRoomId: string, containerName: string, idleTimeoutSupported = false): Promise<WorkerRoute> {
    return this.change(conversationId, current => {
      const route = this.requireAttempt(current, attemptId);
      if (route.phase === "retiring" || route.phase === "sleeping") throw new Error("Worker is retiring.");
      if (route.nativeRoomId && route.nativeRoomId !== nativeRoomId) throw new Error("Worker room binding changed.");
      return { ...route, nativeRoomId, containerName, phase: "ready", idleTimeoutSupported };
    });
  }
  async retiring(conversationId: string, attemptId: string): Promise<void> {
    await this.change(conversationId, current => ({ ...this.requireAttempt(current, attemptId), phase: "retiring" }));
  }
  async beginIdleRetirement(conversationId: string, attemptId: string, minimumIdleMs: number): Promise<void> {
    await this.change(conversationId, current => {
      const route = this.requireAttempt(current, attemptId);
      if (route.phase !== "ready" || !route.idleTimeoutSupported) throw new Error("Worker does not support timed retirement.");
      return { ...route, idleRetirement: { minimumIdleMs } };
    });
  }
  async cancelIdleRetirement(conversationId: string, attemptId: string): Promise<void> {
    await this.change(conversationId, current => {
      const route = { ...this.requireAttempt(current, attemptId) };
      if (route.phase !== "ready") throw new Error("Worker retirement cannot be cancelled.");
      delete route.idleRetirement;
      return route;
    });
  }
  /** The caller has independently confirmed that this exact attempt cannot execute. */
  async sleeping(conversationId: string, attemptId: string): Promise<void> {
    await this.change(conversationId, current => {
      const route = this.requireAttempt(current, attemptId);
      if (route.phase !== "retiring" || !route.idleRetirement) throw new Error("Idle retirement is not recorded.");
      const next: WorkerRoute = { ...route, phase: "sleeping" };
      delete next.idleRetirement;
      delete next.containerName;
      return next;
    });
  }
  /** Invoke only after fresh launcher evidence confirms irreversible retirement. */
  replaceRetired(conversationId: string, oldAttemptId: string, configurationRevision: string): Promise<WorkerRoute> {
    return this.change(conversationId, current => {
      const route = this.requireAttempt(current, oldAttemptId);
      if (route.phase !== "retiring") throw new Error("Persist retirement intent before replacement.");
      const next: WorkerRoute = { ...route, configurationRevision, attemptId: randomUUID(), phase: "pending" };
      delete next.containerName;
      delete next.idleTimeoutSupported;
      delete next.idleRetirement;
      return next;
    });
  }
  /** Caller authenticates the token first. Attempt/revision checks run again
   * inside the mutation queue, so a queued old callback cannot undo replacement.
   */
  async updateSummary(conversationId: string, attemptId: string, storeId: string, input: unknown): Promise<void> {
    const value = workerSummarySchema.parse(input);
    await this.change(conversationId, current => {
      const route = this.requireAttempt(current, attemptId);
      if (route.storeId !== storeId || route.phase === "retiring" || route.phase === "sleeping") throw new Error("Stale worker summary binding.");
      const previous = route.summary;
      if (previous && value.revision < previous.value.revision) throw new Error("Stale worker summary revision.");
      if (previous && value.revision === previous.value.revision) {
        if (JSON.stringify(value) !== JSON.stringify(previous.value)) throw new Error("Conflicting worker summary revision.");
        if (previous.attemptId === attemptId) return route;
      }
      return { ...route, summary: { attemptId, value } };
    });
    this.summaryReceivedAt.set(conversationId, performance.now());
  }
  /** Historical observations survive replacement, but are not current liveness. */
  readSummary(conversationId: string): WorkerSummaryObservation | undefined {
    const route = this.get(conversationId);
    if (!route?.summary) return undefined;
    const receivedAt = this.summaryReceivedAt.get(conversationId);
    return { value: route.summary.value, stale: route.summary.attemptId !== route.attemptId || (route.phase === "sleeping" && route.summary.value.status === "running") || (route.phase !== "sleeping"
      && (route.phase === "retiring" || receivedAt === undefined || performance.now() - receivedAt >= 10_000)) };
  }
  close(): Promise<void> { return this.db.close(); }
  private requireAttempt(route: WorkerRoute | undefined, attemptId: string) {
    if (!route || route.attemptId !== attemptId) throw new Error("Stale worker attempt.");
    return route;
  }
  private decode(conversationId: string, body: string): WorkerRoute {
    const route = routeSchema.parse(JSON.parse(body));
    if (route.conversationId !== conversationId || route.scope.companyId !== route.companyId) throw new Error("Invalid routing scope binding.");
    return route;
  }
  private change(conversationId: string, operation: (route: WorkerRoute | undefined) => WorkerRoute): Promise<WorkerRoute> {
    return this.db.change(conversationId, body => {
      const next = operation(body === undefined ? undefined : this.decode(conversationId, body));
      const encoded = JSON.stringify(routeSchema.parse(next));
      const result = this.decode(conversationId, encoded);
      return { body: encoded === body ? undefined : encoded, result };
    });
  }
}
