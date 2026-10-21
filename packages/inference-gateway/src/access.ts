import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { GetSecretValueCommand, type SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { AccessStore, publicCredential, randomToken, tokenHash, type Credential, type Employee, type LoginFlow, type UsageReceipt } from "./access-store.js";
import type { GatewayAuth } from "./auth.js";
import { budgetSchema, grantsSchema, HttpError, idSchema, permitted, type GatewayConfig, type Principal } from "./config.js";
import { json, readJson } from "./http.js";

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const result = schema.safeParse(value);
  if (!result.success) throw new HttpError(400, "invalid_request");
  return result.data;
};
const clientName = z.string().trim().min(1).max(100);
const revision = z.uuid().optional();
const employeeInput = z.object({ email: z.email().max(320), enabled: z.boolean(), grants: grantsSchema, budget: budgetSchema.optional(), revision, revokeCredentials: z.boolean().optional() }).strict();
const loginInput = z.object({ clientName, codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/), redirectUri: z.url().optional() }).strict();
const codeInput = z.object({ flow: z.uuid(), code: z.string().min(1), codeVerifier: z.string().regex(/^[A-Za-z0-9_-]{43,128}$/) }).strict();
const refreshInput = z.object({ refreshToken: z.string().min(1) }).strict();
const keyInput = z.object({ clientName, grants: grantsSchema, expiresAt: z.number().int().positive().optional() }).strict();
const budgetInput = z.object({ budget: budgetSchema.nullable(), revision }).strict();
const monthSchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
const challenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const callbackPath = "/v1/auth/google/callback";

function page(response: ServerResponse, title: string, content: string) {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'", "x-content-type-options": "nosniff" });
  response.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:18px/1.6 system-ui;background:#f6f6f3;color:#1c2420;margin:0;padding:10vh 24px}main{max-width:600px;margin:auto;background:white;border:1px solid #dde3da;border-radius:20px;padding:40px}h1{line-height:1.2;font-size:30px}code{display:block;overflow-wrap:anywhere;padding:16px;background:#eef3ec;border-radius:8px}</style><main><small>Dispatch inference gateway</small><h1>${title}</h1>${content}</main></html>`);
}

export class GatewayAccess {
  private readonly jwks = createRemoteJWKSet(new URL("https://www.googleapis.com/oauth2/v3/certs"));
  private googleSecret?: Promise<string>;
  constructor(readonly config: GatewayConfig, readonly store: AccessStore, private readonly auth: GatewayAuth, private readonly secrets: SecretsManagerClient) {}

  private session(credential: Credential, refreshToken: string) {
    const access = this.auth.session(credential.principalId, credential.id, Math.min(Date.now() + 10 * 60_000, credential.expiresAt));
    return { accessToken: access.token, expiresAt: access.expiresAt, refreshToken, refreshExpiresAt: credential.expiresAt, credential: publicCredential(credential) };
  }

  private async flow(id: string | null) {
    if (!id || !z.uuid().safeParse(id).success) throw new HttpError(400, "invalid_login_state");
    const flow = await this.store.get<LoginFlow>("LOGIN", id);
    if (!flow || flow.expiresAt <= Date.now()) throw new HttpError(400, "login_expired");
    return flow;
  }

  async publicRoute(request: IncomingMessage, response: ServerResponse, url: URL, signal: AbortSignal): Promise<boolean> {
    const path = url.pathname;
    if (request.method === "POST" && path === "/v1/auth/refresh") {
      const input = parse(refreshInput, await readJson(request));
      const refreshed = await this.store.rotateRefresh(input.refreshToken);
      json(response, 200, this.session(refreshed.credential, refreshed.refreshToken));
      return true;
    }
    const google = this.config.access?.google;
    if (!google) return false;
    if (request.method === "POST" && path === "/v1/auth/start") {
      const input = parse(loginInput, await readJson(request));
      if (input.redirectUri) {
        const redirect = new URL(input.redirectUri);
        if (redirect.protocol !== "http:" || redirect.hostname !== "127.0.0.1" || !redirect.port || redirect.pathname !== "/callback" || redirect.search || redirect.hash || redirect.username || redirect.password) throw new HttpError(400, "loopback_callback_required");
      }
      const flow: LoginFlow = { id: randomUUID(), clientName: input.clientName, challenge: input.codeChallenge, redirectUri: input.redirectUri, verifier: randomToken(), nonce: randomToken(), expiresAt: Date.now() + 10 * 60_000, revision: randomUUID() };
      await this.store.put("LOGIN", flow.id, flow);
      json(response, 200, { flow: flow.id, authorizationUrl: `${this.config.audience}/v1/auth/google?flow=${flow.id}`, expiresAt: flow.expiresAt });
      return true;
    }
    if (request.method === "GET" && path === "/v1/auth/google") {
      const flow = await this.flow(url.searchParams.get("flow"));
      if (flow.browserHash) throw new HttpError(400, "login_already_started");
      const browser = randomToken();
      await this.store.put("LOGIN", flow.id, { ...flow, browserHash: tokenHash(browser), revision: randomUUID() }, flow.revision);
      const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
      authorization.search = new URLSearchParams({ client_id: google.clientId, response_type: "code", scope: "openid email", redirect_uri: `${this.config.audience}${callbackPath}`, state: flow.id, nonce: flow.nonce,
        code_challenge: challenge(flow.verifier), code_challenge_method: "S256", prompt: "select_account", ...(google.hostedDomains.length === 1 ? { hd: google.hostedDomains[0] } : {}) }).toString();
      response.writeHead(302, { location: authorization.toString(), "set-cookie": `dispatch_login_${flow.id}=${browser}; HttpOnly; SameSite=Lax; Path=${callbackPath}; Max-Age=600${this.config.audience.startsWith("https:") ? "; Secure" : ""}`, "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
      return true;
    }
    if (request.method === "GET" && path === callbackPath) {
      const flow = await this.flow(url.searchParams.get("state"));
      const browser = (request.headers.cookie ?? "").split(/;\s*/).find((value) => value.startsWith(`dispatch_login_${flow.id}=`))?.split("=")[1];
      if (!browser || !flow.browserHash || flow.browserHash !== tokenHash(browser) || flow.codeHash) throw new HttpError(400, "invalid_login_state");
      response.setHeader("set-cookie", `dispatch_login_${flow.id}=; HttpOnly; SameSite=Lax; Path=${callbackPath}; Max-Age=0${this.config.audience.startsWith("https:") ? "; Secure" : ""}`);
      if (url.searchParams.has("error")) { page(response, "Sign-in cancelled", "<p>Return to your client and start sign-in again when you are ready.</p>"); return true; }
      const code = url.searchParams.get("code");
      if (!code) throw new HttpError(400, "authorization_code_required");
      this.googleSecret ??= this.secrets.send(new GetSecretValueCommand({ SecretId: google.clientSecretId })).then((value) => {
        if (!value.SecretString) throw new Error("Missing Google client secret");
        return value.SecretString;
      }).catch((error) => { this.googleSecret = undefined; throw error; });
      const exchange = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), body: new URLSearchParams({ code, client_id: google.clientId, client_secret: await this.googleSecret, code_verifier: flow.verifier, grant_type: "authorization_code", redirect_uri: `${this.config.audience}${callbackPath}` }) });
      if (!exchange.ok) throw new HttpError(401, "google_sign_in_failed");
      const tokens = await exchange.json() as { id_token?: string };
      if (!tokens.id_token) throw new HttpError(401, "google_sign_in_failed");
      const { payload } = await jwtVerify(tokens.id_token, this.jwks, { algorithms: ["RS256"], audience: google.clientId, issuer: ["https://accounts.google.com", "accounts.google.com"], requiredClaims: ["sub", "exp", "iat", "nonce", "hd", "email", "email_verified"], maxTokenAge: "10m" }).catch(() => { throw new HttpError(401, "invalid_google_identity"); });
      if (payload.nonce !== flow.nonce || payload.email_verified !== true || typeof payload.email !== "string" || typeof payload.hd !== "string" || !google.hostedDomains.includes(payload.hd)) throw new HttpError(403, "workspace_not_allowed");
      const employee = await this.store.googleEmployee(payload.sub!, payload.email);
      const gatewayCode = randomToken();
      await this.store.put("LOGIN", flow.id, { ...flow, codeHash: tokenHash(gatewayCode), principalId: employee.id, epoch: employee.epoch, revision: randomUUID() }, flow.revision);
      if (flow.redirectUri) {
        const redirect = new URL(flow.redirectUri);
        redirect.search = new URLSearchParams({ state: flow.id, code: gatewayCode }).toString();
        response.writeHead(302, { location: redirect.toString(), "cache-control": "no-store", "referrer-policy": "no-referrer" }).end();
      } else page(response, "Finish signing in", `<p>Paste this one-time code into the client that started sign-in.</p><code>${gatewayCode}</code><p>The code expires in ten minutes.</p>`);
      return true;
    }
    if (request.method === "POST" && path === "/v1/auth/token") {
      const input = parse(codeInput, await readJson(request));
      const flow = await this.flow(input.flow);
      if (!flow.principalId || flow.codeHash !== tokenHash(input.code) || flow.challenge !== challenge(input.codeVerifier)) throw new HttpError(401, "invalid_authorization_code");
      const employee = await this.store.employee(flow.principalId);
      if (employee.epoch !== flow.epoch) throw new HttpError(401, "login_revoked");
      await this.store.put("LOGIN", flow.id, { ...flow, expiresAt: 0, revision: randomUUID() }, flow.revision);
      const { credential, token } = await this.store.createCredential(employee, "session", flow.clientName);
      json(response, 200, this.session(credential, token));
      return true;
    }
    return false;
  }

  async authenticatedRoute(request: IncomingMessage, response: ServerResponse, url: URL, principal: Principal): Promise<boolean> {
    const path = url.pathname;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const audit = (operation: string, target: string) => process.stdout.write(`${JSON.stringify({ event: "access_change", actor: principal.id, operation, target })}\n`);
    if (path.startsWith("/v1/admin/") && !principal.admin) throw new HttpError(403, "administrator_required");
    if (request.method === "GET" && path === "/v1/me") {
      json(response, 200, { id: principal.id, kind: principal.kind, clientId: principal.clientId, grants: principal.grants, scope: principal.scope, admin: principal.admin });
      return true;
    }
    if (request.method === "GET" && path === "/v1/admin/principals") {
      json(response, 200, await this.store.list<Employee>("EMPLOYEE", cursor)); return true;
    }
    const employeePath = /^\/v1\/admin\/principals\/([a-z0-9][a-z0-9_-]*)$/.exec(path);
    if (employeePath) {
      const id = parse(idSchema, employeePath[1]);
      if (request.method === "GET") {
        const value = await this.store.get<Employee>("EMPLOYEE", id);
        if (!value) throw new HttpError(404, "principal_not_found");
        json(response, 200, value); return true;
      }
      if (request.method === "PUT") {
        if (this.config.principals.some((item) => item.id === id)) throw new HttpError(400, "workload_id_reserved");
        const input = parse(employeeInput, await readJson(request));
        for (const connection of Object.keys(input.grants)) if (connection !== "*" && !this.config.connections.some((item) => item.id === connection)) throw new HttpError(400, "unknown_connection");
        const employee = await this.store.saveEmployee(id, input);
        audit("save_principal", id); json(response, 200, employee); return true;
      }
    }
    if (path === "/v1/admin/budget") {
      if (request.method === "GET") { json(response, 200, (await this.store.companyBudget()) ?? { budget: null }); return true; }
      if (request.method === "PUT") {
        const input = parse(budgetInput, await readJson(request));
        json(response, 200, await this.store.saveCompanyBudget(input.budget ?? undefined, input.revision)); audit("save_budget", "company"); return true;
      }
    }
    const credentialsPath = /^\/v1\/(?:admin\/principals\/([a-z0-9][a-z0-9_-]*)\/)?credentials(?:\/([a-f0-9-]{36}))?$/.exec(path);
    if (credentialsPath) {
      if (!principal.admin && principal.kind !== "session") throw new HttpError(403, "employee_session_required");
      const owner = credentialsPath[1] ?? principal.id;
      if (request.method === "GET" && !credentialsPath[2]) {
        const page = await this.store.list<Credential>(`CREDENTIAL#${owner}`, cursor);
        json(response, 200, { ...page, items: page.items.map(publicCredential) }); return true;
      }
      if (request.method === "DELETE" && credentialsPath[2]) {
        await this.store.revoke(owner, credentialsPath[2]); audit("revoke_credential", credentialsPath[2]); json(response, 200, { revoked: true }); return true;
      }
      if (request.method === "POST" && !credentialsPath[2]) {
        const input = parse(keyInput, await readJson(request));
        const employee = await this.store.employee(owner);
        const ownerPrincipal: Principal = { id: owner, kind: "session", clientId: "", admin: false, grants: employee.grants };
        for (const [connection, models] of Object.entries(input.grants)) if (models.some((model) => !permitted(ownerPrincipal, connection, model))) throw new HttpError(403, "key_scope_exceeds_owner");
        if (input.expiresAt !== undefined && input.expiresAt <= Date.now()) throw new HttpError(400, "expiry_must_be_future");
        const created = await this.store.createCredential(employee, "key", input.clientName, input.grants, input.expiresAt ?? Date.now() + 90 * 24 * 60 * 60_000);
        audit("create_key", created.credential.id); json(response, 201, { key: created.token, credential: publicCredential(created.credential) }); return true;
      }
    }
    if (request.method === "GET" && ["/v1/usage", "/v1/admin/usage", "/v1/admin/requests"].includes(path)) {
      const month = parse(monthSchema, url.searchParams.get("month") ?? new Date().toISOString().slice(0, 7));
      if (path === "/v1/admin/requests") { json(response, 200, await this.store.list(`REQUEST#${month}`, cursor)); return true; }
      const owner = principal.admin ? url.searchParams.get("principal") : principal.id;
      const client = principal.kind === "key" ? principal.clientId : url.searchParams.get("client");
      if (client && !owner) throw new HttpError(400, "principal_required");
      const scope = client ? `CLIENT#${owner}#${client}` : owner ? `PRINCIPAL#${owner}` : "COMPANY";
      json(response, 200, await this.store.usage(scope, month)); return true;
    }
    const reconcile = /^\/v1\/admin\/requests\/(\d{4}-\d{2})\/([a-f0-9-]{36})\/reconcile$/.exec(path);
    if (request.method === "POST" && reconcile) {
      const month = parse(monthSchema, reconcile[1]);
      const receipt = await this.store.get<UsageReceipt>(`REQUEST#${month}`, reconcile[2]);
      if (!receipt) throw new HttpError(404, "request_not_found");
      if (receipt.status === "pending") throw new HttpError(409, "provider_outcome_unknown");
      await this.store.settle(receipt);
      audit("reconcile_usage", receipt.requestId); json(response, 200, { accounted: true }); return true;
    }
    return false;
  }
}
