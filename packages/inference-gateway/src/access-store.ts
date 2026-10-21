import { createHash, randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand, UpdateItemCommand, TransactWriteItemsCommand, TransactionCanceledException, type AttributeValue, type TransactWriteItem } from "@aws-sdk/client-dynamodb";
import { HttpError, type Budget, type GatewayConfig, type Grants, type Principal } from "./config.js";

export type Employee = {
  id: string; email: string; googleSub?: string; enabled: boolean; grants: Grants;
  epoch: number; revision: string; budget?: Budget;
};
export type Credential = {
  id: string; principalId: string; kind: "session" | "key"; clientName: string;
  epoch: number; hash: string; grants?: Grants; createdAt: number; expiresAt: number;
  revoked: boolean; revision: string;
};
export type LoginFlow = {
  id: string; clientName: string; challenge: string; redirectUri?: string;
  verifier: string; nonce: string; browserHash?: string; codeHash?: string;
  principalId?: string; epoch?: number; expiresAt: number; revision: string;
};
type RecordValue = Employee | Credential | LoginFlow | { budget?: Budget; revision: string };
type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; reasoning?: number; cost?: { total: number } };
export type UsageReceipt = {
  requestId: string; principalId: string; clientId: string; connection: string; model: string;
  operation: string; startedAt: number; status: string; durationMs?: number; usage?: Usage;
  deferredUsageKey?: string;
  accounted?: boolean;
  duplicateDeferredUsage?: boolean;
};
export const tokenHash = (value: string) => createHash("sha256").update(value).digest("hex");
export const randomToken = () => randomBytes(32).toString("base64url");
const key = (pk: string, sk: string) => ({ pk: { S: pk }, sk: { S: sk } });
const record = (pk: string, sk: string, value: RecordValue) => ({ ...key(pk, sk), data: { S: JSON.stringify(value) }, revision: { S: value.revision }, ...("expiresAt" in value ? { expires: { N: String(Math.ceil(value.expiresAt / 1000)) } } : {}) });
const parse = <T>(item: Record<string, AttributeValue> | undefined): T | undefined => item?.data?.S ? JSON.parse(item.data.S) as T : undefined;

/** Strong reads make revocation independent of which gateway replica receives the request. */
export class AccessStore {
  readonly client: DynamoDBClient;
  readonly table: string;
  constructor(config: GatewayConfig) {
    if (!config.access) throw new Error("Access storage is not configured");
    this.table = config.access.table;
    this.client = new DynamoDBClient({ region: config.region });
  }
  close() { this.client.destroy(); }

  async get<T>(pk: string, sk: string): Promise<T | undefined> {
    const result = await this.client.send(new GetItemCommand({ TableName: this.table, Key: key(pk, sk), ConsistentRead: true }));
    return parse<T>(result.Item);
  }

  async put(pk: string, sk: string, value: RecordValue, revision?: string): Promise<void> {
    try {
      await this.client.send(new PutItemCommand({ TableName: this.table, Item: record(pk, sk, value),
        ConditionExpression: revision ? "revision = :revision" : "attribute_not_exists(pk)",
        ...(revision ? { ExpressionAttributeValues: { ":revision": { S: revision } } } : {}),
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") throw new HttpError(409, "record_changed");
      throw error;
    }
  }

  async list<T>(pk: string, cursor?: string): Promise<{ items: T[]; cursor?: string }> {
    let start: Record<string, AttributeValue> | undefined;
    if (cursor) {
      try {
        const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString());
        if (decoded.pk?.S !== pk || typeof decoded.sk?.S !== "string") throw new Error();
        start = key(pk, decoded.sk.S);
      } catch { throw new HttpError(400, "invalid_cursor"); }
    }
    const page = await this.client.send(new QueryCommand({ TableName: this.table, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": { S: pk } }, ConsistentRead: true, Limit: 100, ExclusiveStartKey: start }));
    return { items: (page.Items ?? []).map((item) => parse<T>(item)!), ...(page.LastEvaluatedKey ? { cursor: Buffer.from(JSON.stringify(page.LastEvaluatedKey)).toString("base64url") } : {}) };
  }

  async employee(id: string): Promise<Employee> {
    const employee = await this.get<Employee>("EMPLOYEE", id);
    if (!employee?.enabled) throw new HttpError(403, "principal_not_allowed");
    return employee;
  }

  async saveEmployee(id: string, input: { email: string; enabled: boolean; grants: Grants; budget?: Budget; revision?: string; revokeCredentials?: boolean }): Promise<Employee> {
    const previous = await this.get<Employee>("EMPLOYEE", id);
    if ((previous?.revision ?? undefined) !== input.revision) throw new HttpError(409, "record_changed");
    const email = input.email.trim().toLowerCase();
    // Enrollment addresses cannot be reassigned to a different identity by an ordinary grant edit.
    if (previous && previous.email !== email) throw new HttpError(400, "enrollment_email_immutable");
    const employee: Employee = { id, email, enabled: input.enabled, grants: input.grants, budget: input.budget,
      googleSub: previous?.googleSub, epoch: (previous?.epoch ?? 0) + (input.revokeCredentials || (previous?.enabled && !input.enabled) ? 1 : 0), revision: randomUUID() };
    const writes: TransactWriteItem[] = [{ Put: { TableName: this.table, Item: record("EMPLOYEE", id, employee),
      ConditionExpression: previous ? "revision = :revision" : "attribute_not_exists(pk)",
      ...(previous ? { ExpressionAttributeValues: { ":revision": { S: previous.revision } } } : {}),
    } }];
    if (!previous) writes.push({ Put: { TableName: this.table, Item: { ...key("EMAIL", email), data: { S: JSON.stringify({ id }) } }, ConditionExpression: "attribute_not_exists(pk)" } });
    try { await this.client.send(new TransactWriteItemsCommand({ TransactItems: writes })); }
    catch (error) {
      if (error instanceof Error && error.name === "TransactionCanceledException") throw new HttpError(409, "enrollment_conflict");
      throw error;
    }
    return employee;
  }

  async googleEmployee(sub: string, email: string): Promise<Employee> {
    const bound = await this.get<{ id: string }>("GOOGLE", sub);
    if (bound) return this.employee(bound.id);
    const invited = await this.get<{ id: string }>("EMAIL", email.toLowerCase());
    if (!invited) throw new HttpError(403, "principal_not_allowed");
    const employee = await this.employee(invited.id);
    if (employee.googleSub && employee.googleSub !== sub) throw new HttpError(403, "identity_mismatch");
    const next = { ...employee, googleSub: sub, revision: randomUUID() };
    try {
      await this.client.send(new TransactWriteItemsCommand({ TransactItems: [
        { Put: { TableName: this.table, Item: record("EMPLOYEE", employee.id, next), ConditionExpression: "revision = :revision", ExpressionAttributeValues: { ":revision": { S: employee.revision } } } },
        { Put: { TableName: this.table, Item: { ...key("GOOGLE", sub), data: { S: JSON.stringify({ id: employee.id }) } }, ConditionExpression: "attribute_not_exists(pk)" } },
      ] }));
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionCanceledException") throw new HttpError(409, "identity_changed_retry_login");
      throw error;
    }
    return next;
  }

  async createCredential(employee: Employee, kind: Credential["kind"], clientName: string, grants?: Grants, expiresAt = Date.now() + 30 * 24 * 60 * 60_000) {
    const secret = randomToken();
    const credential: Credential = { id: randomUUID(), principalId: employee.id, kind, clientName, epoch: employee.epoch,
      hash: tokenHash(secret), grants, createdAt: Date.now(), expiresAt, revoked: false, revision: randomUUID() };
    await this.put(`CREDENTIAL#${employee.id}`, credential.id, credential);
    return { credential, token: `${kind === "key" ? "dgk" : "dgr"}_${employee.id}.${credential.id}.${secret}` };
  }

  async credential(principalId: string, id: string, kind: Credential["kind"], secret?: string) {
    const [employee, credential] = await Promise.all([this.employee(principalId), this.get<Credential>(`CREDENTIAL#${principalId}`, id)]);
    if (!credential || credential.kind !== kind || credential.revoked || credential.expiresAt <= Date.now() || credential.epoch !== employee.epoch || (secret !== undefined && credential.hash !== tokenHash(secret))) throw new HttpError(401, "credential_revoked_or_expired");
    const principal: Principal = { id: employee.id, grants: employee.grants, scope: credential.grants, kind, admin: false, clientId: credential.id, credentialId: credential.id };
    return { employee, credential, principal };
  }

  async bearer(token: string) {
    const match = /^(dgk|dgr)_([a-z0-9][a-z0-9_-]*)\.([a-f0-9-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
    if (!match) throw new HttpError(401, "unauthorized");
    return { ...await this.credential(match[2], match[3], match[1] === "dgk" ? "key" : "session", match[4]), kind: match[1] };
  }

  async rotateRefresh(token: string) {
    const result = await this.bearer(token);
    if (result.kind !== "dgr") throw new HttpError(401, "invalid_refresh_token");
    const secret = randomToken();
    const next = { ...result.credential, hash: tokenHash(secret), revision: randomUUID() };
    await this.put(`CREDENTIAL#${next.principalId}`, next.id, next, result.credential.revision);
    return { ...result, credential: next, refreshToken: `dgr_${next.principalId}.${next.id}.${secret}` };
  }

  async revoke(principalId: string, id: string) {
    const previous = await this.get<Credential>(`CREDENTIAL#${principalId}`, id);
    if (!previous) throw new HttpError(404, "credential_not_found");
    await this.put(`CREDENTIAL#${principalId}`, id, { ...previous, revoked: true, revision: randomUUID() }, previous.revision);
  }

  async companyBudget() { return this.get<{ budget?: Budget; revision: string }>("POLICY", "COMPANY"); }
  async saveCompanyBudget(budget: Budget | undefined, revision?: string) {
    const next = { budget, revision: randomUUID() };
    await this.put("POLICY", "COMPANY", next, revision);
    return next;
  }

  async usage(scope: string, month: string) {
    const value = await this.client.send(new GetItemCommand({ TableName: this.table, Key: key(`TOTAL#${month}`, scope), ConsistentRead: true }));
    const number = (name: string) => Number(value.Item?.[name]?.N ?? 0);
    return { month, requests: number("requests"), input: number("input"), output: number("output"), cacheRead: number("cacheRead"), cacheWrite: number("cacheWrite"), reasoning: number("reasoning"), estimatedUsd: number("costMicros") / 1_000_000, unpricedRequests: number("unpriced") };
  }

  async admit(principal: Principal, request: UsageReceipt, checkBudget = true): Promise<string[]> {
    const month = new Date(request.startedAt).toISOString().slice(0, 7);
    const [company, employee] = checkBudget ? await Promise.all([this.companyBudget(), this.get<Employee>("EMPLOYEE", principal.id)]) : [undefined, undefined];
    const warnings: string[] = [];
    for (const [scope, budget] of [["COMPANY", company?.budget], [`PRINCIPAL#${principal.id}`, employee?.budget]] as const) {
      if (!budget) continue;
      const total = await this.usage(scope, month);
      if (total.estimatedUsd < budget.monthlyUsd) continue;
      if (budget.mode === "block") throw new HttpError(429, "monthly_budget_exceeded");
      warnings.push(scope === "COMPANY" ? "company_monthly_budget" : "personal_monthly_budget");
    }
    // Persist admission before provider work so interrupted requests remain visible as unsettled.
    await this.client.send(new PutItemCommand({ TableName: this.table, Item: { ...key(`REQUEST#${month}`, request.requestId), data: { S: JSON.stringify(request) } }, ConditionExpression: "attribute_not_exists(pk)" }));
    return warnings;
  }

  async settle(receipt: UsageReceipt, duplicateDeferredUsage = false): Promise<void> {
    const month = new Date(receipt.startedAt).toISOString().slice(0, 7);
    // Keep the reported usage durably available even if aggregate settlement fails.
    try {
      await this.client.send(new UpdateItemCommand({ TableName: this.table, Key: key(`REQUEST#${month}`, receipt.requestId),
        UpdateExpression: "SET #data = :data", ConditionExpression: "attribute_not_exists(settled)", ExpressionAttributeNames: { "#data": "data" },
        ExpressionAttributeValues: { ":data": { S: JSON.stringify({ ...receipt, accounted: false, duplicateDeferredUsage }) } },
      }));
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return;
      throw error;
    }
    const usage = duplicateDeferredUsage ? undefined : receipt.usage;
    const cost = usage?.cost?.total;
    // Providers also use zero for unknown pricing; keep those requests visible for review.
    const priced = typeof cost === "number" && Number.isFinite(cost) && cost > 0;
    const values = { requests: 1, input: usage?.input ?? 0, output: usage?.output ?? 0, cacheRead: usage?.cacheRead ?? 0, cacheWrite: usage?.cacheWrite ?? 0, reasoning: usage?.reasoning ?? 0, costMicros: priced ? Math.round(cost * 1_000_000) : 0, unpriced: priced || duplicateDeferredUsage || receipt.status === "cancelled" ? 0 : 1 };
    const scopes = ["COMPANY", `PRINCIPAL#${receipt.principalId}`, `CLIENT#${receipt.principalId}#${receipt.clientId}`];
    const writes: TransactWriteItem[] = [{ Put: { TableName: this.table, Item: { ...key(`REQUEST#${month}`, receipt.requestId), data: { S: JSON.stringify({ ...receipt, accounted: true, duplicateDeferredUsage }) }, settled: { BOOL: true } }, ConditionExpression: "attribute_not_exists(settled)" } }, ...scopes.map((scope) => ({ Update: {
      TableName: this.table, Key: key(`TOTAL#${month}`, scope),
      UpdateExpression: `ADD ${Object.keys(values).map((name) => `#${name} :${name}`).join(", ")}`,
      ExpressionAttributeNames: Object.fromEntries(Object.keys(values).map((name) => [`#${name}`, name])),
      ExpressionAttributeValues: Object.fromEntries(Object.entries(values).map(([name, value]) => [`:${name}`, { N: String(value) }])),
    } }))];
    if (receipt.deferredUsageKey && usage) writes.push({ Put: { TableName: this.table, Item: { ...key("DEFERRED_USAGE", receipt.deferredUsageKey), requestId: { S: receipt.requestId } }, ConditionExpression: "attribute_not_exists(pk)" } });
    for (let attempt = 0; ; attempt++) {
      try { await this.client.send(new TransactWriteItemsCommand({ TransactItems: writes })); return; }
      catch (error) {
        if (error instanceof TransactionCanceledException) {
          const existing = await this.client.send(new GetItemCommand({ TableName: this.table, Key: key(`REQUEST#${month}`, receipt.requestId), ConsistentRead: true }));
          if (existing.Item?.settled?.BOOL) return;
          if (receipt.deferredUsageKey && !duplicateDeferredUsage) {
            const charged = await this.client.send(new GetItemCommand({ TableName: this.table, Key: key("DEFERRED_USAGE", receipt.deferredUsageKey), ConsistentRead: true }));
            if (charged.Item) return this.settle(receipt, true);
          }
          if (attempt < 7 && error.CancellationReasons?.some((reason) => ["TransactionConflict", "ProvisionedThroughputExceeded", "ThrottlingError"].includes(reason.Code ?? ""))) {
            await delay(Math.min(1000, 25 * 2 ** attempt) * (0.5 + Math.random()));
            continue;
          }
        }
        throw error;
      }
    }
  }
}

export function publicCredential(credential: Credential) {
  const { hash: _hash, epoch: _epoch, ...metadata } = credential;
  return metadata;
}
