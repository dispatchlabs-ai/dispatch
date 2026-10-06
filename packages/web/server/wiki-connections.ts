import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import type { ConnectWikiInput, RuntimeScope, WikiAuthorizationState, WikiScope } from "../src/shared/contracts.js";
import { decryptSecret, digest, encryptSecret, loadSecretKey, randomToken } from "./auth/crypto.js";

const scopes = ["wiki:read", "wiki:write", "wiki:trace"] as const;
const tokensSchema = z.object({
  access_token: z.string().min(1), refresh_token: z.string().min(1),
  token_type: z.string().refine(value => value.toLowerCase() === "bearer"),
  expires_in: z.number().int().positive(), scope: z.string(),
});
type Tokens = z.infer<typeof tokensSchema> & { expiresAt: number };
type OAuthConfig = { issuer: string; clientId: string; authorize: string; token: string; revoke: string };
type ConnectionRow = {
  id: string; company_id: string; owner_id: string; name: string; endpoint: string;
  state: WikiAuthorizationState; config: string; secret: string | null; identity: string;
  upstream_agent: string; upstream_run: string; scopes: string; created_at: number;
  error: string | null; refreshing: number;
};
type PendingRow = { state_hash: string; connection_id: string; session_id: string; verifier: string; expires_at: number; request_id: string; fingerprint: string; authorization_url: string; consumed: number };
export type WikiConnectionRecord = {
  id: string; companyId: string; ownerId: string; name: string; endpoint: string;
  authorization: WikiAuthorizationState; identity: string; upstreamAgent: string;
  scopes: WikiScope[]; createdAt: number; error?: string;
};

export class WikiConnectionError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function endpointURL(value: string) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || !/^\/mcp\/?$/.test(url.pathname)) {
    throw new WikiConnectionError(400, "Use the Wiki's HTTPS MCP address, ending in /mcp.");
  }
  url.pathname = "/mcp";
  return url;
}

function sameOriginURL(value: string, origin: string) {
  const url = new URL(value);
  if (url.origin !== origin || url.username || url.password || url.hash) throw new WikiConnectionError(400, "The Wiki returned an unsupported authorization address.");
  return url.href;
}

async function jsonResponse(response: Response) {
  if (!response.ok) throw new WikiConnectionError(502, "The Wiki did not accept the request. Check its address and permissions, then try again.");
  if (!response.headers.get("content-type")?.includes("application/json")) throw new WikiConnectionError(502, "The Wiki returned an unexpected response.");
  return response.json() as Promise<unknown>;
}

/** OAuth for an existing Wiki identity. This service never creates a Wiki agent. */
export class WikiConnections {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;
  private readonly renewals = new Map<string, Promise<string>>();
  private readonly starts = new Map<string, { fingerprint: string; operation: Promise<{ id: string; authorizationUrl: string }> }>();
  private readonly changes = new Map<string, Promise<unknown>>();
  readonly redirectURI: string;

  constructor(databasePath: string, keyPath: string, private readonly origin: string) {
    mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(databasePath);
    chmodSync(databasePath, 0o600);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS wiki_connections (
        id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL,
        name TEXT NOT NULL, endpoint TEXT NOT NULL, state TEXT NOT NULL,
        config TEXT NOT NULL, secret TEXT, identity TEXT NOT NULL DEFAULT '',
        upstream_agent TEXT NOT NULL DEFAULT '', upstream_run TEXT NOT NULL DEFAULT '',
        scopes TEXT NOT NULL, created_at INTEGER NOT NULL, error TEXT, refreshing INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS wiki_oauth_pending (
        state_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES wiki_connections(id),
        session_id TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL,
        request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, authorization_url TEXT NOT NULL,
        consumed INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id, request_id)
      );
    `);
    this.key = loadSecretKey(keyPath, !!this.db.prepare("SELECT 1 FROM wiki_connections WHERE secret IS NOT NULL UNION SELECT 1 FROM wiki_oauth_pending LIMIT 1").get());
    this.redirectURI = origin + "/api/connections/oauth/callback";
  }

  recoverInterruptedRenewals() {
    // A rotating refresh may have succeeded remotely before the process stopped.
    // Never replay that refresh token after an uncertain outcome.
    this.db.prepare("UPDATE wiki_connections SET state='reauthorize', refreshing=0, error=? WHERE refreshing=1").run("Credential renewal was interrupted. Authorize this connection again.");
  }

  private row(id: string): ConnectionRow {
    const row = this.db.prepare("SELECT * FROM wiki_connections WHERE id=?").get(id) as ConnectionRow | undefined;
    if (!row) throw new WikiConnectionError(404, "Connection not found.");
    return row;
  }

  private owned(scope: RuntimeScope, id: string) {
    const row = this.row(id);
    if (row.company_id !== scope.companyId || row.owner_id !== scope.userId) throw new WikiConnectionError(404, "Connection not found.");
    return row;
  }

  record(id: string): WikiConnectionRecord {
    const row = this.row(id);
    return { id: row.id, companyId: row.company_id, ownerId: row.owner_id, name: row.name, endpoint: row.endpoint,
      authorization: row.state, identity: row.identity, upstreamAgent: row.upstream_agent,
      scopes: JSON.parse(row.scopes) as WikiScope[], createdAt: row.created_at, ...(row.error ? { error: row.error } : {}) };
  }

  list(companyId: string) {
    return (this.db.prepare("SELECT id FROM wiki_connections WHERE company_id=? ORDER BY created_at DESC").all(companyId) as { id: string }[]).map(({ id }) => this.record(id));
  }

  requireAssignment(scope: RuntimeScope, id: string) {
    const row = this.owned(scope, id);
    if (row.state !== "authorized") throw new WikiConnectionError(409, "Authorize the Wiki connection before adding it to an agent.");
  }

  start(scope: RuntimeScope & { sessionId: string }, input: ConnectWikiInput) {
    const key = `${scope.sessionId}/${input.requestId}`;
    const fingerprint = JSON.stringify(input);
    const pending = this.starts.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new WikiConnectionError(409, "This connection request has changed. Start a new authorization.");
      return pending.operation;
    }
    const operation = (input.connectionId ? this.change(input.connectionId, () => this.startOnce(scope, input)) : this.startOnce(scope, input)).finally(() => this.starts.delete(key));
    this.starts.set(key, { fingerprint, operation });
    return operation;
  }

  // Authorizing and disconnecting the same credential must have a single order.
  private change<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.changes.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(action).finally(() => {
      if (this.changes.get(id) === operation) this.changes.delete(id);
    });
    this.changes.set(id, operation);
    return operation;
  }

  private async startOnce(scope: RuntimeScope & { sessionId: string }, input: ConnectWikiInput) {
    const endpoint = endpointURL(input.endpoint);
    const requested = [...new Set(input.scopes)].sort();
    if (!requested.includes("wiki:read") || requested.some(value => !scopes.includes(value))) throw new WikiConnectionError(400, "Article reading is required for a Wiki connection.");
    const fingerprint = JSON.stringify([input.connectionId, input.name.trim(), endpoint.href, requested]);
    const prior = this.db.prepare("SELECT * FROM wiki_oauth_pending WHERE session_id=? AND request_id=?").get(scope.sessionId, input.requestId) as PendingRow | undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw new WikiConnectionError(409, "This connection request has changed. Start a new authorization.");
      if (prior.consumed || prior.expires_at <= Date.now()) throw new WikiConnectionError(409, "This authorization has finished or expired. Start a new authorization.");
      return { id: prior.connection_id, authorizationUrl: decryptSecret(prior.authorization_url, this.key) };
    }
    const existing = input.connectionId ? this.owned(scope, input.connectionId) : undefined;
    if (existing) {
      if (existing.endpoint !== endpoint.href) throw new WikiConnectionError(400, "Create a separate connection for another Wiki.");
      if (JSON.stringify([...JSON.parse(existing.scopes) as WikiScope[]].sort()) !== JSON.stringify(requested)) throw new WikiConnectionError(400, "Create a new connection to change its permissions, then choose which agent instances receive it.");
      if (existing.secret) await this.revokeOnce(scope, existing.id);
    }
    const metadata = z.object({ issuer: z.string(), authorization_endpoint: z.string(), token_endpoint: z.string(), registration_endpoint: z.string(), revocation_endpoint: z.string(), code_challenge_methods_supported: z.array(z.string()) })
      .parse(await jsonResponse(await fetch(endpoint.origin + "/.well-known/oauth-authorization-server", { redirect: "error", signal: AbortSignal.timeout(30_000) })));
    if (metadata.issuer !== endpoint.origin || !metadata.code_challenge_methods_supported.includes("S256")) throw new WikiConnectionError(400, "This Wiki does not advertise the required OAuth authorization flow.");
    const registration = sameOriginURL(metadata.registration_endpoint, endpoint.origin);
    const config: OAuthConfig = { issuer: endpoint.origin, clientId: "", authorize: sameOriginURL(metadata.authorization_endpoint, endpoint.origin), token: sameOriginURL(metadata.token_endpoint, endpoint.origin), revoke: sameOriginURL(metadata.revocation_endpoint, endpoint.origin) };
    const client = z.object({ client_id: z.string().min(1), redirect_uris: z.array(z.string()) }).parse(await jsonResponse(await fetch(registration, {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "error", signal: AbortSignal.timeout(30_000),
      body: JSON.stringify({ client_name: "Dispatch", redirect_uris: [this.redirectURI], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] }),
    })));
    if (!client.redirect_uris.includes(this.redirectURI)) throw new WikiConnectionError(400, "The Wiki did not register Dispatch's callback address.");
    config.clientId = client.client_id;
    const verifier = randomToken(), state = randomToken(), id = existing?.id ?? randomUUID();
    const url = new URL(config.authorize);
    url.search = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: this.redirectURI,
      scope: requested.join(" "), state, resource: endpoint.href, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url") }).toString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`INSERT INTO wiki_connections (id,company_id,owner_id,name,endpoint,state,config,scopes,created_at)
        VALUES (?,?,?,?,?,'pending',?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,state='pending',config=excluded.config,scopes=excluded.scopes,error=NULL,refreshing=0`)
        .run(id, scope.companyId, scope.userId, input.name.trim(), endpoint.href, JSON.stringify(config), JSON.stringify(requested), Date.now());
      this.db.prepare("UPDATE wiki_oauth_pending SET consumed=1 WHERE connection_id=?").run(id);
      this.db.prepare("INSERT INTO wiki_oauth_pending VALUES (?,?,?,?,?,?,?,?,0)").run(digest(state), id, scope.sessionId, encryptSecret(verifier, this.key), Date.now() + 15 * 60_000, input.requestId, fingerprint, encryptSecret(url.href, this.key));
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return { id, authorizationUrl: url.href };
  }

  async complete(scope: RuntimeScope & { sessionId: string }, params: URLSearchParams) {
    const pending = this.db.prepare("SELECT connection_id FROM wiki_oauth_pending WHERE state_hash=?").get(digest(params.get("state") || "")) as { connection_id: string } | undefined;
    if (!pending) throw new WikiConnectionError(400, "This authorization has expired. Return to Dispatch and try again.");
    return this.change(pending.connection_id, () => this.completeOnce(scope, params));
  }

  private async completeOnce(scope: RuntimeScope & { sessionId: string }, params: URLSearchParams) {
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new WikiConnectionError(400, "The authorization response is invalid. Start again from Dispatch.");
    const pending = this.db.prepare("SELECT * FROM wiki_oauth_pending WHERE state_hash=?").get(digest(params.get("state") || "")) as PendingRow | undefined;
    if (!pending || pending.session_id !== scope.sessionId || pending.expires_at <= Date.now()) throw new WikiConnectionError(400, "This authorization has expired or belongs to another session. Return to Dispatch and try again.");
    const row = this.owned(scope, pending.connection_id);
    const config = JSON.parse(row.config) as OAuthConfig;
    if (params.get("iss") !== config.issuer) throw new WikiConnectionError(400, "The authorization response came from a different Wiki.");
    if (pending.consumed) return { id: row.id, authorized: row.state === "authorized" };
    this.db.prepare("UPDATE wiki_oauth_pending SET consumed=1 WHERE state_hash=?").run(pending.state_hash);
    if (params.has("error")) {
      this.mark(row.id, "error", "Wiki authorization was cancelled. You can try again when ready.");
      return { id: row.id, authorized: false };
    }
    if (!params.get("code")) throw new WikiConnectionError(400, "The Wiki did not return an authorization code.");
    try {
      const tokens = await this.exchange(config, { grant_type: "authorization_code", code: params.get("code")!, redirect_uri: this.redirectURI,
        code_verifier: decryptSecret(pending.verifier, this.key), resource: row.endpoint }, JSON.parse(row.scopes) as WikiScope[]);
      // Persist received credentials before discovery so an interrupted callback is recoverable.
      this.db.prepare("UPDATE wiki_connections SET secret=?,state='pending',error=NULL WHERE id=?").run(encryptSecret(JSON.stringify(tokens), this.key), row.id);
      await this.identify(row.id, true);
      this.mark(row.id, "authorized", null);
      return { id: row.id, authorized: true };
    } catch {
      this.mark(row.id, "reauthorize", "Authorization could not be confirmed. Return to Dispatch and authorize again.");
      return { id: row.id, authorized: false };
    }
  }

  private async exchange(config: OAuthConfig, input: Record<string, string>, allowed: WikiScope[]) {
    const response = await fetch(config.token, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ ...input, client_id: config.clientId }) });
    const tokens = tokensSchema.parse(await jsonResponse(response));
    const granted = tokens.scope.split(" ").filter(Boolean);
    if (!granted.includes("wiki:read") || granted.some(value => !allowed.includes(value as WikiScope))) throw new WikiConnectionError(400, "The Wiki returned unexpected permissions.");
    return { ...tokens, expiresAt: Date.now() + tokens.expires_in * 1000 };
  }

  private mark(id: string, state: WikiAuthorizationState, error: string | null) {
    this.db.prepare("UPDATE wiki_connections SET state=?,error=?,refreshing=0 WHERE id=?").run(state, error, id);
  }

  async identify(id: string, provisional = false) {
    const row = this.row(id);
    const token = provisional ? (JSON.parse(decryptSecret(row.secret!, this.key)) as Tokens).access_token : await this.token(id);
    const info = z.object({ agent: z.string().min(1), run: z.string().min(1), mode: z.literal("independent"), scope: z.array(z.object({ space: z.string(), actions: z.array(z.string()) })) })
      .parse(await jsonResponse(await this.fetch(id, new URL("/api/agent/run", row.endpoint), { headers: { Authorization: `Bearer ${token}` } }, provisional)));
    if (row.upstream_agent && row.upstream_agent !== info.agent) throw new WikiConnectionError(409, "Choose the same Wiki agent when renewing this connection. Create a new connection for a different identity.");
    const current = this.row(id);
    const tokens = JSON.parse(decryptSecret(current.secret!, this.key)) as Tokens;
    this.db.prepare("UPDATE wiki_connections SET upstream_agent=?,upstream_run=?,scopes=? WHERE id=?").run(info.agent, info.run, JSON.stringify(tokens.scope.split(" ")), id);
  }

  setIdentity(id: string, instructions: string) {
    const match = /Authenticated agent: (.+?)\. Definition [a-f0-9-]+:/s.exec(instructions);
    const row = this.row(id);
    this.db.prepare("UPDATE wiki_connections SET identity=? WHERE id=?").run(match?.[1]?.slice(0, 200) || row.upstream_agent, id);
  }

  async token(id: string): Promise<string> {
    const row = this.row(id);
    if (row.state !== "authorized" || !row.secret) throw new WikiConnectionError(401, "Authorize this Wiki connection in Settings → Connections.");
    const tokens = JSON.parse(decryptSecret(row.secret, this.key)) as Tokens;
    if (tokens.expiresAt > Date.now() + 30_000) return tokens.access_token;
    const active = this.renewals.get(id);
    if (active) return active;
    const renewal = this.renew(row, tokens).finally(() => this.renewals.delete(id));
    this.renewals.set(id, renewal);
    return renewal;
  }

  private async renew(row: ConnectionRow, previous: Tokens) {
    this.db.prepare("UPDATE wiki_connections SET refreshing=1 WHERE id=?").run(row.id);
    try {
      const next = await this.exchange(JSON.parse(row.config) as OAuthConfig, { grant_type: "refresh_token", refresh_token: previous.refresh_token, resource: row.endpoint }, JSON.parse(row.scopes) as WikiScope[]);
      if (this.row(row.id).state !== "authorized") throw new WikiConnectionError(401, "This connection was disconnected during renewal.");
      this.db.prepare("UPDATE wiki_connections SET secret=?,refreshing=0 WHERE id=?").run(encryptSecret(JSON.stringify(next), this.key), row.id);
      return next.access_token;
    } catch {
      if (this.row(row.id).state === "authorized") this.mark(row.id, "reauthorize", "Credential renewal could not be confirmed. Authorize this connection again.");
      throw new WikiConnectionError(401, "This Wiki connection needs authorization again.");
    }
  }

  authProvider(id: string): AuthProvider {
    return {
      token: () => this.token(id),
      onUnauthorized: async ({ token }) => {
        const row = this.row(id);
        if (!row.secret || row.state !== "authorized") throw new WikiConnectionError(401, "This Wiki connection needs authorization again.");
        const saved = JSON.parse(decryptSecret(row.secret, this.key)) as Tokens;
        if (token && saved.access_token !== token) return;
        saved.expiresAt = 0;
        this.db.prepare("UPDATE wiki_connections SET secret=? WHERE id=?").run(encryptSecret(JSON.stringify(saved), this.key), id);
        await this.token(id);
      },
    };
  }

  async fetch(id: string, input: string | URL, init?: RequestInit, provisional = false) {
    const row = this.row(id), url = new URL(input);
    if (row.state !== "authorized" && !(provisional && row.state === "pending" && url.pathname === "/api/agent/run")) throw new WikiConnectionError(401, "This Wiki connection is not authorized.");
    if (url.origin !== new URL(row.endpoint).origin || url.username || url.password || !["/mcp", "/api/agent/run"].includes(url.pathname)) throw new WikiConnectionError(400, "Wiki credential destination rejected.");
    return fetch(url, { ...init, redirect: "error", ...(url.pathname === "/api/agent/run" ? { signal: AbortSignal.timeout(30_000) } : {}) });
  }

  revoke(scope: RuntimeScope, id: string) {
    this.owned(scope, id);
    return this.change(id, () => this.revokeOnce(scope, id));
  }

  private async revokeOnce(scope: RuntimeScope, id: string) {
    let row = this.owned(scope, id);
    this.db.prepare("UPDATE wiki_oauth_pending SET consumed=1 WHERE connection_id=?").run(id);
    this.mark(id, "revoking", "Access is disabled in Dispatch. Wiki revocation is pending.");
    const renewal = this.renewals.get(id);
    if (renewal) await renewal.catch(() => {});
    row = this.owned(scope, id);
    if (row.secret) {
      const tokens = JSON.parse(decryptSecret(row.secret, this.key)) as Tokens;
      const config = JSON.parse(row.config) as OAuthConfig;
      try {
        const response = await fetch(config.revoke, { method: "POST", redirect: "error", signal: AbortSignal.timeout(30_000),
          headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ client_id: config.clientId, token: tokens.refresh_token }) });
        if (!response.ok) throw new Error("Revocation rejected");
      } catch { throw new WikiConnectionError(502, "Dispatch access is disabled, but Wiki revocation could not be confirmed. Retry disconnecting."); }
    }
    this.db.prepare("UPDATE wiki_connections SET secret=NULL,state='revoked',error=NULL,refreshing=0 WHERE id=?").run(id);
  }

  async close() {
    await Promise.allSettled([...this.changes.values(), ...this.renewals.values(), ...[...this.starts.values()].map(start => start.operation)]);
    this.db.close();
  }
}
