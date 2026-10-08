import { isIPv4 } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DispatchRuntime, RuntimeError } from "../runtime.js";
import type { RuntimeService } from "../runtime-service.js";
import type { ChatSnapshot, RuntimeScope } from "../../src/shared/contracts.js";
import { WorkerRoutes, type WorkerRoute } from "./routes.js";
import { workerToken } from "./identity.js";
import { decodeAttachmentBytes } from "./attachments.js";
import { mergeWorkerSummary } from "./summaries.js";
import type { Attachment } from "../../src/shared/contracts.js";
import { workerRequest } from "./transport.js";
import type { LaunchAttempt, LauncherStatus } from "./launcher.js";

export type DistributedOptions = {
  launcherTimeoutMs?: number; installationId: string; workerKey: string; launcherUrl: string; launcherToken: string;
  runBackground<T>(operation: () => Promise<T>): Promise<T>;
  runPolicyChange?: <T>(operation: () => Promise<T>) => Promise<T>;
  configurationRevision: string; directory: DispatchRuntime; routes: WorkerRoutes;
};
export function distributedRuntime(options: DistributedOptions): RuntimeService {
  const { directory, routes } = options;
  const launching = new Map<string, Promise<WorkerRoute>>();
  // Read leases cover authorization, activation and RPC completion. A policy writer
  // seals later leases synchronously, then joins the earlier ones before changing
  // policy or taking launcher inventory. Ordinary conversations remain concurrent.
  let policyTail: Promise<unknown> = Promise.resolve();
  const reads = new Set<Promise<unknown>>();
  function policyRead<T>(operation: () => Promise<T>): Promise<T> {
    const result = policyTail.then(operation);
    reads.add(result);
    void result.then(() => reads.delete(result), () => reads.delete(result));
    return result;
  }
  function policyChange<T>(operation: () => Promise<T>): Promise<T> {
    const result = Promise.allSettled([policyTail, ...reads]).then(() =>
      options.runPolicyChange ? options.runPolicyChange(operation) : operation());
    policyTail = result.catch(() => {});
    return result;
  }
  const launcher = <T>(path: string, body?: unknown) => workerRequest<T>(options.launcherUrl, options.launcherToken, `/v1/${path}`, body, undefined, options.launcherTimeoutMs ?? 300_000);
  const token = (route: WorkerRoute) => workerToken(options.workerKey, options.installationId, route);
  async function activate(route: WorkerRoute): Promise<WorkerRoute> {
    const existing = launching.get(route.conversationId); if (existing) return existing;
    const work = (async () => {
      const status = await launcher<LauncherStatus>("status");
      if (status.drained || !status.driverReachable) throw new RuntimeError(503, "Worker admission unavailable.");
      const previous = status.attempts.find(attempt => attempt.attemptId === route.attemptId);
      if (previous?.phase === "stopped" && previous.observed === "absent") {
        await routes.retiring(route.conversationId, route.attemptId);
        route = await routes.replaceRetired(route.conversationId, route.attemptId, options.configurationRevision);
      }
      const attempt = await launcher<LaunchAttempt>("ensure", { attemptId: route.attemptId, conversationId: route.conversationId, storeId: route.storeId, configurationRevision: route.configurationRevision });
      if (attempt.phase !== "running") throw new RuntimeError(503, "Conversation worker requires reconciliation.");
      const address = workerAddress(attempt);
      const origin = `http://${address}:8831`;
      for (let i = 0; i < 40; i++) {
        try {
          const ready = await workerRequest<{ roomId: string; conversationId: string; attemptId: string }>(origin, token(route), "/ready");
          if (ready.conversationId !== route.conversationId || ready.attemptId !== route.attemptId) throw new Error("Worker readiness identity mismatch.");
          return await routes.ready(route.conversationId, route.attemptId, ready.roomId, address);
        } catch (error) { if (i === 39) throw error; await delay(250); }
      }
      throw new RuntimeError(503, "Worker did not become ready.");
    })();
    launching.set(route.conversationId, work);
    try { return await work; } finally { launching.delete(route.conversationId); }
  }
  function call<T>(scope: RuntimeScope, id: string, method: string, input?: unknown): Promise<T> {
    return policyRead(() => callNow<T>(scope, id, method, input));
  }
  async function callNow<T>(scope: RuntimeScope, id: string, method: string, input?: unknown): Promise<T> {
    // Recheck backend-authoritative project/membership policy on every request.
    await directory.getChat(scope, id);
    const bootstrap = await directory.directoryChatBootstrap(scope, id);
    const route = routes.get(id) ?? await routes.ensure(id, bootstrap.scope, bootstrap.input, options.configurationRevision);
    if (route.companyId !== scope.companyId) throw new RuntimeError(503, "Conversation worker unavailable.");
    const active = await activate(route);
    const membership = await directory.directoryWorkerMembership(scope, id);
    const catalog = await directory.exportWorkerCatalog(scope.companyId);
    const response = await workerRequest<{ result: T }>(`http://${active.containerName}:8831`, token(active), "/rpc", { scope: { companyId: scope.companyId, userId: scope.userId }, method, input, catalog, membership });
    return response.result;
  }
  async function acknowledgePolicy(companyId?: string) {
    const status = await launcher<LauncherStatus>("status");
    if (!status.driverReachable) throw new RuntimeError(503, "Cannot confirm worker policy propagation.");
    for (const route of routes.list().filter(route => !companyId || route.companyId === companyId)) {
      const attempt = status.attempts.find(item => item.attemptId === route.attemptId);
      if (!attempt) {
        // Absence is not a stop fence: an earlier ensure may have timed out in
        // transport before reaching the launcher. Tombstone that exact identity
        // before acknowledging policy, then leave a fresh dormant route intent.
        const stopped = await launcher<{ attemptId: string; phase: string }>("stop", { attemptId: route.attemptId });
        const fresh = await launcher<LauncherStatus>("status");
        const retired = fresh.attempts.find(item => item.attemptId === route.attemptId);
        if (stopped.attemptId !== route.attemptId || stopped.phase !== "stopped" || !fresh.driverReachable
          || fresh.containers.some(item => item.attemptId === route.attemptId)
          || (retired && (retired.phase !== "stopped" || retired.observed !== "absent")))
          throw new RuntimeError(503, "Worker policy update remains unresolved.");
        await routes.retiring(route.conversationId, route.attemptId);
        await routes.replaceRetired(route.conversationId, route.attemptId, options.configurationRevision);
        continue;
      }
      if (attempt.phase === "stopped" && attempt.observed === "absent") continue;
      const { catalog, membership } = await directory.directoryWorkerBootstrap(route.companyId, route.conversationId);
      try {
        if (attempt.phase !== "running") throw new Error("Worker is not ready for policy acknowledgement.");
        const receipt = await workerRequest<{ revision: number; membershipRevision: number }>(`http://${workerAddress(attempt)}:8831`, token(route), "/sync", { catalog, membership });
        if (receipt.revision !== catalog.revision || receipt.membershipRevision !== membership.revision) throw new Error("Policy acknowledgement mismatch.");
      } catch {
        // No acknowledgement is safe only after independent irreversible retirement.
        await launcher("stop", { attemptId: route.attemptId });
        const fresh = await launcher<LauncherStatus>("status");
        const retired = fresh.attempts.find(item => item.attemptId === route.attemptId);
        if (!fresh.driverReachable || retired?.phase !== "stopped" || retired.observed !== "absent")
          throw new RuntimeError(503, "Worker policy update remains unresolved.");
        await routes.retiring(route.conversationId, route.attemptId);
      }
    }
  }
  const snapshot = (value: ChatSnapshot, id: string): ChatSnapshot => ({ ...value, conversation: { ...value.conversation, id } });
  const overrides: Partial<RuntimeService> = {
    async listChats(scope) {
      const entries = await directory.directoryChatSummaries(scope);
      return entries.map(({ conversation, automaticTitle }) => mergeWorkerSummary(conversation, automaticTitle, routes.readSummary(conversation.id)))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    },
    async saveAgent(scope, input) {
      if (!input.applyConnectionsToExisting) return directory.saveAgent(scope, input);
      return policyChange(async () => {
        const result = await directory.saveAgent(scope, input);
        await acknowledgePolicy(scope.companyId);
        return result;
      });
    },
    async saveProject(scope, id, input) {
      return policyChange(async () => {
        const result = await directory.saveProject(scope, id, input);
        await acknowledgePolicy(scope.companyId);
        return result;
      });
    },
    async refreshMcpConnections(id) {
      return policyChange(async () => {
        await directory.refreshMcpConnections(id);
        await acknowledgePolicy();
      });
    },
    async reconnectAgentConnection(scope, agentId, connectionId) {
      return policyChange(async () => {
        const result = await directory.reconnectAgentConnection(scope, agentId, connectionId);
        await acknowledgePolicy(scope.companyId);
        return result;
      });
    },
    async authorizeAttachmentUpload(scope, id) { return call(scope, id, "authorizeAttachmentUpload"); },
    async uploadAttachment(scope, id, file) {
      await call(scope, id, "authorizeAttachmentUpload");
      return call(scope, id, "uploadAttachment", { name: file.name, mimeType: file.type, dataBase64: Buffer.from(await file.arrayBuffer()).toString("base64") });
    },
    async downloadAttachment(scope, id, attachmentId) {
      const result = await call<{ attachment: Attachment; dataBase64: string }>(scope, id, "downloadAttachment", attachmentId);
      return { attachment: result.attachment, bytes: decodeAttachmentBytes(result.dataBase64) };
    },
    async createChat(scope, input) {
      const chat = await directory.createChat(scope, input);
      const bootstrap = await directory.directoryChatBootstrap(scope, chat.conversation.id);
      await routes.ensure(chat.conversation.id, bootstrap.scope, bootstrap.input, options.configurationRevision);
      return snapshot(await call<ChatSnapshot>(scope, chat.conversation.id, "getChat"), chat.conversation.id);
    },
    async getChat(scope, id) { return snapshot(await call<ChatSnapshot>(scope, id, "getChat"), id); },
    async submit(scope, id, input) { return call(scope, id, "submit", input); },
    async composing(scope, id, input) { return call(scope, id, "composing", input); },
    async addParticipants(scope, id, input) {
      await directory.inviteWorkerParticipants(scope, id, input);
      return snapshot(await call<ChatSnapshot>(scope, id, "getChat"), id);
    },
    async stop(scope, id) { return snapshot(await call<ChatSnapshot>(scope, id, "stop"), id); },
    async updateChat(scope, id, input) {
      await directory.updateChat(scope, id, input);
      return snapshot(await call<ChatSnapshot>(scope, id, "updateChat", input), id);
    },
    async renameChat(scope, id, title) {
      await directory.renameChat(scope, id, title);
      return snapshot(await call<ChatSnapshot>(scope, id, "renameChat", title), id);
    },
    async watchChat(scope, id) {
      const value = snapshot(await call<ChatSnapshot>(scope, id, "getChat"), id);
      let stopped = false; let started = false;
      let finish!: (value: { reason: "stopped" | "listener_error" | "session_closed" }) => void;
      const closed = new Promise<{ reason: "stopped" | "listener_error" | "session_closed" }>(resolve => { finish = resolve; });
      return { value, closed,
        async deliver(deliver: () => void | Promise<void>) { await options.runBackground(() => policyRead(async () => { await directory.getChat(scope, id); if (!stopped) await deliver(); })); },
        start(listener: (value: ChatSnapshot) => Promise<void>) {
          if (started) throw new Error("Watch already started"); started = true;
          void (async () => {
            let previous = JSON.stringify(value);
            try {
              while (!stopped) {
                await delay(500); if (stopped) break;
                const next = await options.runBackground(async () => snapshot(await call<ChatSnapshot>(scope, id, "getChat"), id));
                const encoded = JSON.stringify(next);
                if (encoded !== previous && !stopped) {
                  await options.runBackground(() => policyRead(async () => {
                    await directory.getChat(scope, id);
                    if (!stopped) await listener(next);
                  }));
                  previous = encoded;
                }
              }
            } catch { stopped = true; finish({ reason: "listener_error" }); }
          })();
        },
        async stop() { stopped = true; finish({ reason: "stopped" }); return closed; },
      };
    },
    async close() {
      const results = await Promise.allSettled([Promise.resolve().then(() => directory.close()), Promise.resolve().then(() => routes.close())]);
      const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
      if (failures.length) throw new AggregateError(failures, "Distributed runtime teardown failed.");
    },
  };
  // Bound delegation preserves the native catalog API without duplicating its policy.
  return new Proxy(directory, { get(target, property) {
    const replacement = overrides[property as keyof RuntimeService];
    if (replacement) return replacement;
    const value = Reflect.get(target, property);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

/** Only the authenticated launcher selects the host; never accept arbitrary RPC URLs. */
function workerAddress(attempt: LaunchAttempt): string {
  if (attempt.address !== undefined) {
    if (!isIPv4(attempt.address)) throw new Error("Invalid worker ENI address.");
    return attempt.address;
  }
  if (!/^dispatch-worker-[a-f0-9]+$/.test(attempt.name)) throw new Error("Invalid worker network identity.");
  return attempt.name;
}
