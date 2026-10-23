import { createHash, randomUUID } from "node:crypto";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { z } from "zod";
import type { RuntimeScope } from "../../src/shared/contracts.js";
import type { GitHubConnection, GitHubCredential, GitHubGrantedRepository, GitHubOperation, GitHubRepositoryBinding } from "../../src/shared/github-access.js";
import { requireProjectAccess } from "../project-access.js";
import { GitHubBrokerClient } from "./client.js";
import { RuntimeError } from "../runtime-error.js";

const GitHubAccessDoc = defineDoc<{
  connections: GitHubConnection[];
  repositories: GitHubRepositoryBinding[];
  receipts: Record<string, { fingerprint: string; result: GitHubConnection | GitHubRepositoryBinding | { removed: string } }>;
}>({ checkpointWhen: () => false, kind: "dispatch.github-access", version: 1, scope: "session", initial: () => ({ connections: [], repositories: [], receipts: {} }) });
type ReceiptResult = GitHubConnection | GitHubRepositoryBinding | { removed: string };
type State = { connections: GitHubConnection[]; repositories: GitHubRepositoryBinding[]; receipts: Record<string, { fingerprint: string; result: ReceiptResult }> };
type Actor = { companyId: string; definitionId: string; projectId: string | undefined };
type Commit = <T>(operation: (tx: Tx) => Promise<T>) => Promise<T>;
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const revision = z.number().int().nonnegative();
const request = z.object({ requestId: z.string().uuid(), revision });
const connectionWrite = request.extend({ action: z.enum(["connect", "disconnect"]), connectionId: z.string().min(1).max(200) }).strict();
const repositoryWrite = request.extend({ action: z.literal("bind"), projectId: z.string().uuid(), connectionId: z.string().min(1),
  repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
const accessWrite = request.extend({ action: z.enum(["grant", "remove"]), projectId: z.string().uuid(), bindingId: z.string().uuid(),
  definitionId: z.string().min(1).optional(), permission: z.enum(["read", "write", "none"]).optional() }).strict();
export const gitHubWriteSchema = z.discriminatedUnion("action", [
  connectionWrite.extend({ action: z.literal("connect") }), connectionWrite.extend({ action: z.literal("disconnect") }), repositoryWrite,
  accessWrite.extend({ action: z.literal("grant") }), accessWrite.extend({ action: z.literal("remove") }),
]);
export type GitHubWrite = z.infer<typeof gitHubWriteSchema>;

export class GitHubAccessError extends RuntimeError {}

export class GitHubAccess {
  constructor(private readonly commit: Commit, private readonly broker: GitHubBrokerClient | undefined,
    private readonly definitionExists: (tx: Tx, companyId: string, definitionId: string) => Promise<boolean>,
    private readonly readAll: (scope: RuntimeScope) => boolean) {}

  private manager(scope: RuntimeScope) {
    return this.broker?.companyId === scope.companyId && this.broker.managerUserIds.includes(scope.userId);
  }
  private requireManager(scope: RuntimeScope) {
    if (!this.manager(scope)) throw new GitHubAccessError(403, "GitHub connection management is restricted to configured administrators.");
  }
  private service(companyId: string) {
    if (!this.broker || this.broker.companyId !== companyId) throw new GitHubAccessError(503, "GitHub access has not been configured for this company.");
    return this.broker;
  }
  private connection(state: State, companyId: string, connectionId: string) {
    const record = state.connections.find(connection => connection.companyId === companyId && connection.id === connectionId);
    if (!record?.connected) throw new GitHubAccessError(403, "GitHub connection is disconnected or unavailable.");
    return record;
  }
  private receipt(state: State, scope: RuntimeScope, input: GitHubWrite) {
    const key = JSON.stringify([scope.companyId, scope.userId, input.requestId]);
    const fingerprint = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const prior = state.receipts[key];
    if (prior && prior.fingerprint !== fingerprint) throw new GitHubAccessError(409, "This request ID was used for a different change.");
    return { prior, save: (result: ReceiptResult) => { state.receipts[key] = { fingerprint, result: copy(result) }; return copy(result); } };
  }
  private checkRevision(actual: number, expected: number) {
    if (actual !== expected) throw new GitHubAccessError(409, "GitHub access changed. Reload the saved access and review your change before saving again.");
  }

  async status(scope: RuntimeScope, projectId?: string) {
    const state = await this.commit(async tx => {
      if (projectId) await requireProjectAccess(tx, scope, projectId, "read", this.readAll(scope));
      const state = await tx.doc(GitHubAccessDoc);
      return { connections: copy(state.connections.filter(connection => connection.companyId === scope.companyId)),
        repositories: projectId ? copy(state.repositories.filter(repository => repository.companyId === scope.companyId && repository.projectId === projectId)) : [] };
    });
    return { configured: this.broker?.companyId === scope.companyId, canManage: this.manager(scope), ...state };
  }
  async availableAccounts(scope: RuntimeScope) {
    this.requireManager(scope);
    return this.service(scope.companyId).accounts();
  }
  async repositories(scope: RuntimeScope, projectId: string, connectionId: string, page: number) {
    const authorize = () => this.commit(async tx => {
      await requireProjectAccess(tx, scope, projectId, "manage");
      return copy(this.connection(await tx.doc(GitHubAccessDoc), scope.companyId, connectionId));
    });
    const before = await authorize();
    const result = await this.service(scope.companyId).repositories(connectionId, page);
    this.checkRevision((await authorize()).revision, before.revision);
    return result;
  }

  async write(scope: RuntimeScope, raw: unknown) {
    const input = gitHubWriteSchema.parse(raw);
    if (input.action === "connect" || input.action === "disconnect") {
      this.requireManager(scope);
      const identity = input.action === "connect"
        ? (await this.service(scope.companyId).accounts()).accounts.find(account => account.id === input.connectionId) : undefined;
      if (input.action === "connect" && !identity) throw new GitHubAccessError(404, "The configured GitHub installation is unavailable.");
      return this.commit(async tx => {
        this.requireManager(scope);
        const state = await tx.doc(GitHubAccessDoc);
        const receipt = this.receipt(state, scope, input);
        if (receipt.prior) return copy(receipt.prior.result);
        const prior = state.connections.find(connection => connection.companyId === scope.companyId && connection.id === input.connectionId);
        this.checkRevision(prior?.revision ?? 0, input.revision);
        if (prior && identity && (prior.appId !== identity.appId || prior.installationId !== identity.installationId || prior.accountId !== identity.accountId))
          throw new GitHubAccessError(409, "The configured installation identity changed. Existing access cannot be transferred to another installation.");
        if (!prior && !identity) throw new GitHubAccessError(404, "GitHub connection not found.");
        const next = { ...(identity ?? prior!), companyId: scope.companyId, connected: input.action === "connect", revision: input.revision + 1 };
        if (prior) Object.assign(prior, next); else state.connections.push(next);
        return receipt.save(next);
      });
    }
    // Project mutations and their retry receipts require current manager authority.
    await this.commit(async tx => { await requireProjectAccess(tx, scope, input.projectId, "manage"); });
    if (input.action === "bind") {
      const before = await this.commit(async tx => copy(this.connection(await tx.doc(GitHubAccessDoc), scope.companyId, input.connectionId)));
      this.checkRevision(before.revision, input.revision);
      const verified = await this.service(scope.companyId).repository(input.connectionId, input.repositoryId);
      return this.commit(async tx => {
        await requireProjectAccess(tx, scope, input.projectId, "manage");
        const state = await tx.doc(GitHubAccessDoc);
        const receipt = this.receipt(state, scope, input);
        if (receipt.prior) return copy(receipt.prior.result);
        const connection = this.connection(state, scope.companyId, input.connectionId);
        this.checkRevision(connection.revision, input.revision);
        if (verified.account.appId !== connection.appId || verified.account.installationId !== connection.installationId)
          throw new GitHubAccessError(409, "GitHub installation changed during repository selection.");
        if (state.repositories.some(repository => repository.companyId === scope.companyId && repository.projectId === input.projectId && repository.id === input.repositoryId))
          throw new GitHubAccessError(409, "This repository is already connected to the project.");
        const binding = { ...verified.repository, bindingId: randomUUID(), companyId: scope.companyId, projectId: input.projectId,
          connectionId: input.connectionId, revision: 1, grants: [] };
        state.repositories.push(binding);
        return receipt.save(binding);
      });
    }
    return this.commit(async tx => {
      await requireProjectAccess(tx, scope, input.projectId, "manage");
      const state = await tx.doc(GitHubAccessDoc);
      const receipt = this.receipt(state, scope, input);
      if (receipt.prior) return copy(receipt.prior.result);
      const binding = state.repositories.find(repository => repository.bindingId === input.bindingId && repository.companyId === scope.companyId && repository.projectId === input.projectId);
      if (!binding) throw new GitHubAccessError(404, "Repository binding no longer exists.");
      this.checkRevision(binding.revision, input.revision);
      if (input.action === "remove") {
        state.repositories = state.repositories.filter(repository => repository !== binding);
        return receipt.save({ removed: input.bindingId });
      }
      if (!input.definitionId || !input.permission || !(await this.definitionExists(tx, scope.companyId, input.definitionId)))
        throw new GitHubAccessError(404, "Choose a current agent and an access level.");
      if (input.permission !== "none") {
        const connection = this.connection(state, scope.companyId, binding.connectionId);
        if (input.permission === "write" && !connection.canWrite) throw new GitHubAccessError(403, "This installation does not have write access.");
      }
      binding.grants = binding.grants.filter(grant => grant.definitionId !== input.definitionId);
      if (input.permission !== "none") binding.grants.push({ definitionId: input.definitionId, permission: input.permission });
      binding.revision++;
      return receipt.save(binding);
    });
  }

  private async authorized(tx: Tx, actor: Actor, bindingId?: string, operation?: GitHubOperation) {
    this.service(actor.companyId);
    if (!actor.projectId) throw new GitHubAccessError(403, "GitHub tools require a project with an explicit repository grant.");
    const state = await tx.doc(GitHubAccessDoc);
    const records = state.repositories.filter(repository => repository.companyId === actor.companyId && repository.projectId === actor.projectId);
    const granted = records.flatMap(repository => {
      const grant = repository.grants.find(grant => grant.definitionId === actor.definitionId);
      const connection = state.connections.find(connection => connection.companyId === actor.companyId && connection.id === repository.connectionId && connection.connected);
      return grant && connection ? [{ repository, grant, connection }] : [];
    });
    if (!bindingId) return granted;
    const record = granted.find(record => record.repository.bindingId === bindingId);
    if (!record || (operation === "push" && record.grant.permission !== "write")) throw new GitHubAccessError(403, "This agent is not granted the requested repository operation.");
    return [record];
  }
  async agentAccess(authorize: (tx: Tx) => Promise<Actor>, bindingId?: string, operation?: GitHubOperation, signal?: AbortSignal): Promise<{ repositories: GitHubGrantedRepository[] } | GitHubCredential> {
    const inspect = () => this.commit(async tx => {
      const actor = await authorize(tx);
      return { actor, records: copy(await this.authorized(tx, actor, bindingId, operation)) };
    });
    const before = await inspect();
    if (!bindingId) return { repositories: before.records.map(({ repository, grant, connection }) => ({
      id: repository.id, name: repository.name, url: repository.url, private: repository.private, defaultBranch: repository.defaultBranch,
      bindingId: repository.bindingId, permission: grant.permission, bot: connection.bot,
    })) };
    const record = before.records[0];
    const credential = await this.service(before.actor.companyId).credential(record.connection.id, record.repository.id, operation === "push" ? "write" : "read", signal);
    signal?.throwIfAborted();
    const after = await inspect();
    const current = after.records[0];
    if (JSON.stringify(before.actor) !== JSON.stringify(after.actor) || current.repository.revision !== record.repository.revision || current.connection.revision !== record.connection.revision
      || credential.account.appId !== current.connection.appId || credential.account.installationId !== current.connection.installationId
      || credential.repository.id !== current.repository.id) throw new GitHubAccessError(409, "Repository authorization changed during credential acquisition.");
    return { ...credential.repository, bindingId, permission: current.grant.permission, bot: credential.account.bot,
      token: credential.token, expiresAt: credential.expiresAt };
  }
}
