import { z } from "zod";
import { HistoryCursorError } from "../chat-pages.js";
import { decodeProjectArchive } from "../project-archives.js";
import { PROJECT_ARCHIVE_MAX_BYTES, type ProjectArchive } from "../../src/shared/project-archives.js";
import { awaitWorkerLaunch } from "./startup.js";
import { isIPv4 } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { DispatchRuntime, RuntimeError } from "../runtime.js";
import type { RuntimeService } from "../runtime-service.js";
import type { ChatSnapshot, RuntimeScope, CreateAgentInstanceResult } from "../../src/shared/contracts.js";
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
export type DistributedRuntime = RuntimeService & {
  deferCatalogReconciliation(companyId: string): void;
  runWorkerTransition<T>(operation: () => Promise<T>): Promise<T>;
  retireIdleWorkers(): Promise<boolean>;
};
export function distributedRuntime(options: DistributedOptions): DistributedRuntime {
  const { directory, routes } = options;
  const launching = new Map<string, Promise<WorkerRoute>>();
  // A warm address is a transport hint, never authorization or a retirement fence.
  // Restart and failed RPCs require the existing launcher reconciliation path again.
  const activated = new Map<string, string>();
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
  const launcher = <T>(path: string, body?: unknown, timeoutMs = options.launcherTimeoutMs ?? 300_000) => workerRequest<T>(options.launcherUrl, options.launcherToken, `/v1/${path}`, body, undefined, timeoutMs);
  const token = (route: WorkerRoute) => workerToken(options.workerKey, options.installationId, route);
  async function activate(route: WorkerRoute): Promise<WorkerRoute> {
    if (route.phase === "ready" && route.containerName && activated.get(route.conversationId) === route.attemptId) return route;
    const existing = launching.get(route.conversationId); if (existing) return existing;
    const work = (async () => {
      const status = await launcher<LauncherStatus>("status");
      if (status.drained || !status.driverReachable) throw new RuntimeError(503, "Worker admission unavailable.");
      const previous = status.attempts.find(attempt => attempt.attemptId === route.attemptId);
      if (previous?.phase === "stopped" && previous.observed === "absent") {
        await routes.retiring(route.conversationId, route.attemptId);
        route = await routes.replaceRetired(route.conversationId, route.attemptId, options.configurationRevision);
      }
      const request = { attemptId: route.attemptId, conversationId: route.conversationId, storeId: route.storeId, configurationRevision: route.configurationRevision };
      const attempt = await awaitWorkerLaunch(
        timeout => launcher<LaunchAttempt>("ensure", request, timeout),
        timeout => launcher<LaunchAttempt>("reconcile", { attemptId: request.attemptId }, timeout),
        request, options.launcherTimeoutMs ?? 300_000,
      );
      if (attempt.phase !== "running") throw new RuntimeError(503, "Conversation worker requires reconciliation.");
      const address = workerAddress(attempt);
      const origin = `http://${address}:8831`;
      for (let i = 0; i < 40; i++) {
        try {
          const ready = await workerRequest<{ roomId: string; conversationId: string; attemptId: string }>(origin, token(route), "/ready");
          if (ready.conversationId !== route.conversationId || ready.attemptId !== route.attemptId) throw new Error("Worker readiness identity mismatch.");
          const active = await routes.ready(route.conversationId, route.attemptId, ready.roomId, address);
          activated.set(active.conversationId, active.attemptId);
          return active;
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
    // This projection checks current project/membership access without constructing
    // and discarding a directory transcript. The policy lease covers RPC completion.
    const membership = await directory.directoryWorkerMembership(scope, id);
    let route = routes.get(id);
    if (!route) {
      const bootstrap = await directory.directoryChatBootstrap(scope, id);
      route = await routes.ensure(id, bootstrap.scope, bootstrap.input, options.configurationRevision);
    }
    if (route.companyId !== scope.companyId) throw new RuntimeError(503, "Conversation worker unavailable.");
    const active = await activate(route);
    const catalog = await directory.exportWorkerCatalog(scope.companyId);
    try {
      const response = await workerRequest<{ result: T }>(`http://${active.containerName}:8831`, token(active), "/rpc", { scope: { companyId: scope.companyId, userId: scope.userId }, method, input, catalog, membership });
      return response.result;
    } catch (error) {
      const applicationRejection = error instanceof HistoryCursorError
        || (error instanceof RuntimeError && [400, 403, 404, 409, 410, 413].includes(error.status));
      if (!applicationRejection && activated.get(id) === active.attemptId) activated.delete(id);
      // Never replay an uncertain mutation. A later request reconciles this same
      // attempt; replacement still requires confirmed irreversible retirement.
      throw error;
    }
  }
  async function acknowledgePolicy(companyId?: string, requireRevocationFence = true) {
    const status = await launcher<LauncherStatus>("status");
    if (!status.driverReachable) throw new RuntimeError(503, "Cannot confirm worker policy propagation.");
    for (const route of routes.list().filter(route => !companyId || route.companyId === companyId)) {
      const attempt = status.attempts.find(item => item.attemptId === route.attemptId);
      if (!attempt && !requireRevocationFence) continue;
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
        if (!requireRevocationFence) throw new RuntimeError(503, "Catalog propagation remains pending; worker execution was not interrupted.");
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
  function deferCatalogReconciliation(companyId: string): void {
    // Admit now so shutdown joins the deferred work, but never await a worker
    // callback from the management RPC that its native transaction is awaiting.
    void options.runBackground(async () => {
      await delay(0);
      await policyChange(() => acknowledgePolicy(companyId, false));
    }).catch(() => {
      console.error("Deferred worker catalog reconciliation failed; reconciliation is required.");
    });
  }
  const snapshot = (value: ChatSnapshot, id: string): ChatSnapshot => ({ ...value, conversation: { ...value.conversation, id } });
  const operations = {
    async exportProjectArchive(scope, id, chatIds) {
      return policyRead(async () => {
        await directory.authorizeProjectExport(scope, id, chatIds);
        const archive = await directory.exportProjectArchive(scope, id, []);
        let bytes = Buffer.byteLength(JSON.stringify(archive));
        for (const chatId of chatIds) {
          const exported = decodeProjectArchive(JSON.stringify(await callNow<ProjectArchive>(scope, chatId, "exportProjectArchive", { projectId: id })));
          bytes += Buffer.byteLength(JSON.stringify(exported.chats));
          if (bytes > PROJECT_ARCHIVE_MAX_BYTES) throw new RuntimeError(413, "Selected content exceeds 32 MiB.");
          archive.chats.push(...exported.chats);
        }
        archive.chats.forEach((chat, index) => { chat.key = `c${index}`; });
        const result = decodeProjectArchive(JSON.stringify(archive));
        await directory.authorizeProjectExport(scope, id, chatIds);
        return result;
      });
    },
    async listChats(scope) {
      const entries = await directory.directoryChatSummaries(scope);
      return entries.map(({ conversation, automaticTitle }) => mergeWorkerSummary(conversation, automaticTitle, routes.readSummary(conversation.id)))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
    },
    async saveAgent(scope, input) {
      return policyChange(async () => {
        const result = await directory.saveAgent(scope, input);
        await acknowledgePolicy(scope.companyId, input.applyConnectionsToExisting === true);
        return result;
      });
    },
    async applyGitHubBundle(scope, input) {
      return policyChange(async () => {
        const result = await directory.applyGitHubBundle(scope, input);
        await acknowledgePolicy(scope.companyId, false);
        return result;
      });
    },
    async archiveAgent(scope, id, revision) {
      return policyChange(async () => {
        const result = await directory.archiveAgent(scope, id, revision);
        await acknowledgePolicy(scope.companyId, false);
        return result;
      });
    },
    async saveProject(scope, id, input) {
      if (input.cwd) throw new RuntimeError(400, "Hosted conversations use their dedicated worker workspace.");
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
    async transcriptPage(scope, id, query) { return call(scope, id, "transcriptPage", query); },
    async publicDetail(scope, id, kind, itemId) { return call(scope, id, "publicDetail", { kind, itemId }); },
    async saveDefinitionOfDone(scope, id, input) { return snapshot(await call<ChatSnapshot>(scope, id, "saveDefinitionOfDone", input), id); },
    async getChat(scope, id) { return snapshot(await call<ChatSnapshot>(scope, id, "getChat"), id); },
    async submit(scope, id, input) { return call(scope, id, "submit", input); },
    async submitAndGetChat(scope, id, input) { return snapshot(await call<ChatSnapshot>(scope, id, "submitAndGetChat", input), id); },
    async composing(scope, id, input) { return call(scope, id, "composing", input); },
    async createAgentInstance(scope, id, input) {
      return policyRead(async () => {
        const admitted = await directory.admitWorkerInstance(scope, id, input);
        const result = await callNow<CreateAgentInstanceResult>(scope, id, "workerInstanceResult", { actorId: admitted.actorId });
        return { ...snapshot(result, id), createdParticipantId: result.createdParticipantId };
      });
    },
    async removeParticipant(scope, id, participantId) {
      return policyChange(async () => {
        await directory.removeWorkerParticipant(scope, id, participantId);
        return snapshot(await callNow<ChatSnapshot>(scope, id, "removeParticipant", { participantId }), id);
      });
    },
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
        async deliver(deliver: () => void | Promise<void>) { await options.runBackground(() => policyRead(async () => { await directory.directoryWorkerMembership(scope, id); if (!stopped) await deliver(); })); },
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
                    await directory.directoryWorkerMembership(scope, id);
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
  } satisfies Partial<RuntimeService>;
  // Every application method is classified explicitly. New runtime APIs must select
  // catalog authority or conversation execution here rather than silently falling through.
  return {
    importProjectArchive: directory.importProjectArchive.bind(directory),
    getProjectArchive: directory.getProjectArchive.bind(directory),
    getProjectSpec: directory.getProjectSpec.bind(directory),
    saveProjectSpec: directory.saveProjectSpec.bind(directory),
    listGitHubBundles: directory.listGitHubBundles.bind(directory),
    previewGitHubBundle: directory.previewGitHubBundle.bind(directory),
    exportBundle: directory.exportBundle.bind(directory),
    previewBundle: directory.previewBundle.bind(directory),
    importBundle: directory.importBundle.bind(directory),
    evaluationProfile: directory.evaluationProfile.bind(directory),
    evaluationProfileRevision: directory.evaluationProfileRevision.bind(directory),
    saveEvaluationProfile: directory.saveEvaluationProfile.bind(directory),
    agentConnections: directory.agentConnections.bind(directory),
    createProject: directory.createProject.bind(directory),
    getSkill: directory.getSkill.bind(directory),
    listAgents: directory.listAgents.bind(directory),
    listMcpConnections: directory.listMcpConnections.bind(directory),
    listProjects: directory.listProjects.bind(directory),
    listSkills: directory.listSkills.bind(directory),
    managementGrants: directory.managementGrants.bind(directory),
    saveManagementGrant: directory.saveManagementGrant.bind(directory),
    saveSkill: directory.saveSkill.bind(directory),
    getDefaultAgent: directory.getDefaultAgent.bind(directory),
    ...operations,
    deferCatalogReconciliation,
    runWorkerTransition: policyChange,
    async retireIdleWorkers() {
      // Backend admission must already be sealed and joined. Support callbacks stay open.
      const before = await launcher<LauncherStatus>("status");
      if (before.installationId !== options.installationId || !before.driverReachable
        || before.unresolvedAttempts.length || before.orphanContainerIds.length) throw new Error("Worker inventory is unresolved.");
      for (const attempt of before.attempts.filter(item => item.phase !== "stopped")) {
        const route = routes.get(attempt.conversationId);
        if (!route || route.phase !== "ready" || route.attemptId !== attempt.attemptId || route.storeId !== attempt.storeId)
          throw new Error("Worker route is unresolved.");
        const result = z.object({ idle: z.boolean(), attemptId: z.string() }).strict().parse(await workerRequest(
          `http://${workerAddress(attempt)}:8831`, token(route), "/idle-retire", {}, undefined, options.launcherTimeoutMs,
        ));
        if (result.attemptId !== attempt.attemptId) throw new Error("Worker retirement identity mismatch.");
        if (!result.idle) return false;
        await launcher("stop", { attemptId: attempt.attemptId });
        const status = await launcher<LauncherStatus>("status");
        const retired = status.attempts.find(item => item.attemptId === attempt.attemptId);
        if (status.installationId !== options.installationId || !status.driverReachable
          || retired?.phase !== "stopped" || retired.observed !== "absent") throw new Error("Retirement is not confirmed.");
        await routes.retiring(route.conversationId, route.attemptId);
        activated.delete(route.conversationId);
      }
      const after = await launcher<LauncherStatus>("status");
      if (after.installationId !== options.installationId || !after.driverReachable || after.containers.length
        || after.unresolvedAttempts.length || after.orphanContainerIds.length
        || after.attempts.some(attempt => attempt.phase !== "stopped" || attempt.observed !== "absent"))
        throw new Error("Worker retirement remains unresolved.");
      return true;
    },
  } satisfies DistributedRuntime;
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
