import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ConnectMcpInput, ConnectMcpResult, ConnectionAuthentication, ConnectionAuthorizationState, RuntimeScope } from "../src/shared/contracts.js";
import { decryptSecret, digest, encryptSecret, loadSecretKey, randomToken } from "./auth/crypto.js";
import { ConnectionError, RenewalError, connectionURL, exchangeCode, prepareOAuth, refreshTokens, revokeTokens, type OAuthConfiguration, type StoredTokens } from "./mcp-oauth.js";
import { legacyWikiIdentity, verifyLegacyWikiIdentity } from "./legacy-wiki-connection.js";

export { ConnectionError } from "./mcp-oauth.js";
type ConnectionRow = {
  id: string; company_id: string; owner_id: string; name: string; endpoint: string;
  state: ConnectionAuthorizationState; authentication: ConnectionAuthentication; provider: string;
  config: string; secret: string | null; identity: string; server_name: string;
  upstream_agent: string; upstream_run: string; scopes: string; created_at: number;
  error: string | null; refreshing: number; disconnect_notice: string | null;
};
type Credential = { tokens?: StoredTokens; client?: OAuthClientInformationMixed; headers?: Record<string, string> };
type PendingRow = { state_hash: string; connection_id: string; session_id: string; verifier: string; expires_at: number; request_id: string; fingerprint: string; authorization_url: string; consumed: number };
export type ManagedConnectionRecord = {
  id: string; companyId: string; ownerId: string; name: string; endpoint: string;
  authentication: ConnectionAuthentication; authorization: ConnectionAuthorizationState; identity: string; serverName: string;
  scopes: string[]; createdAt: number; error?: string; disconnectNotice?: string;
};

export class McpConnections {
  private db?: DatabaseSync;
  private key!: Buffer;
  private readonly renewals = new Map<string, Promise<string | undefined>>();
  private readonly starts = new Map<string, { fingerprint: string; operation: Promise<ConnectMcpResult> }>();
  private readonly changes = new Map<string, Promise<unknown>>();
  readonly redirectURI: string;

  constructor(private readonly databasePath: string, private readonly keyPath: string, origin: string) {
    this.redirectURI = origin + "/api/connections/oauth/callback";
  }

  // Called only after the runtime has acquired the installation's owner lock.
  initialize() {
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    const db = this.db = new DatabaseSync(this.databasePath);
    chmodSync(this.databasePath, 0o600);
    db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    const legacy = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='wiki_connections'").get());
    db.exec("BEGIN IMMEDIATE");
    try {
      if (legacy) {
        db.exec(`ALTER TABLE wiki_connections RENAME TO mcp_connections;
          ALTER TABLE wiki_oauth_pending RENAME TO mcp_oauth_pending;
          ALTER TABLE mcp_connections ADD COLUMN authentication TEXT NOT NULL DEFAULT 'oauth';
          ALTER TABLE mcp_connections ADD COLUMN provider TEXT NOT NULL DEFAULT 'agent-wiki';
          ALTER TABLE mcp_connections ADD COLUMN server_name TEXT NOT NULL DEFAULT '';
          ALTER TABLE mcp_connections ADD COLUMN disconnect_notice TEXT;`);
      }
      db.exec(`CREATE TABLE IF NOT EXISTS mcp_connections (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL, owner_id TEXT NOT NULL,
          name TEXT NOT NULL, endpoint TEXT NOT NULL, state TEXT NOT NULL,
          authentication TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', config TEXT NOT NULL,
          secret TEXT, identity TEXT NOT NULL DEFAULT '', server_name TEXT NOT NULL DEFAULT '',
          upstream_agent TEXT NOT NULL DEFAULT '', upstream_run TEXT NOT NULL DEFAULT '',
          scopes TEXT NOT NULL, created_at INTEGER NOT NULL, error TEXT, refreshing INTEGER NOT NULL DEFAULT 0, disconnect_notice TEXT
        );
        CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
          state_hash TEXT PRIMARY KEY, connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
          session_id TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL,
          request_id TEXT NOT NULL, fingerprint TEXT NOT NULL, authorization_url TEXT NOT NULL,
          consumed INTEGER NOT NULL DEFAULT 0, UNIQUE(session_id, request_id)
        );
        CREATE TABLE IF NOT EXISTS mcp_connection_requests (
          session_id TEXT NOT NULL, request_id TEXT NOT NULL, connection_id TEXT NOT NULL REFERENCES mcp_connections(id),
          fingerprint TEXT NOT NULL, PRIMARY KEY(session_id,request_id)
        );`);
      this.key = loadSecretKey(this.keyPath, Boolean(db.prepare("SELECT 1 FROM mcp_connections WHERE secret IS NOT NULL UNION SELECT 1 FROM mcp_oauth_pending LIMIT 1").get()));
      if (legacy) {
        for (const row of db.prepare("SELECT * FROM mcp_connections").all() as ConnectionRow[]) {
          const old = JSON.parse(row.config) as { issuer: string; clientId: string; authorize: string; token: string; revoke: string };
          const requestedScopes = JSON.parse(row.scopes) as string[];
          const config: OAuthConfiguration = { issuer: old.issuer, resource: row.endpoint, requestedScopes,
            metadata: { issuer: old.issuer, authorization_endpoint: old.authorize, token_endpoint: old.token, revocation_endpoint: old.revoke,
              response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true } };
          const credential: Credential = { client: { client_id: old.clientId, issuer: old.issuer },
            ...(row.secret ? { tokens: { ...JSON.parse(decryptSecret(row.secret, this.key)) as StoredTokens, issuer: old.issuer } } : {}) };
          db.prepare("UPDATE mcp_connections SET config=?,secret=? WHERE id=?").run(JSON.stringify(config), encryptSecret(JSON.stringify(credential), this.key), row.id);
        }
      }
      db.prepare("UPDATE mcp_connections SET state='reauthorize',refreshing=0,error=? WHERE refreshing=1")
        .run("Credential renewal was interrupted. Authorize this connection again.");
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  }

  private row(id: string): ConnectionRow {
    const row = this.db!.prepare("SELECT * FROM mcp_connections WHERE id=?").get(id) as ConnectionRow | undefined;
    if (!row) throw new ConnectionError(404, "Connection not found.");
    return row;
  }

  private owned(scope: RuntimeScope, id: string) {
    const row = this.row(id);
    if (row.company_id !== scope.companyId || row.owner_id !== scope.userId) throw new ConnectionError(404, "Connection not found.");
    return row;
  }

  private credential(row: ConnectionRow): Credential {
    return row.secret ? JSON.parse(decryptSecret(row.secret, this.key)) as Credential : {};
  }

  record(id: string): ManagedConnectionRecord {
    const row = this.row(id);
    return { id: row.id, companyId: row.company_id, ownerId: row.owner_id, name: row.name, endpoint: row.endpoint,
      authentication: row.authentication, authorization: row.state, identity: row.identity, serverName: row.server_name,
      scopes: JSON.parse(row.scopes) as string[], createdAt: row.created_at, ...(row.error ? { error: row.error } : {}),
      ...(row.disconnect_notice ? { disconnectNotice: row.disconnect_notice } : {}) };
  }

  list(companyId: string) {
    return (this.db!.prepare("SELECT id FROM mcp_connections WHERE company_id=? ORDER BY created_at DESC").all(companyId) as { id: string }[]).map(({ id }) => this.record(id));
  }

  requireAssignment(scope: RuntimeScope, id: string) {
    if (this.owned(scope, id).state !== "authorized") throw new ConnectionError(409, "Finish connecting the server before adding it to an agent.");
  }

  start(scope: RuntimeScope & { sessionId: string }, input: ConnectMcpInput) {
    const key = `${scope.sessionId}/${input.requestId}`;
    const fingerprint = createHmac("sha256", this.key).update(JSON.stringify(input)).digest("hex");
    const pending = this.starts.get(key);
    if (pending) {
      if (pending.fingerprint !== fingerprint) throw new ConnectionError(409, "This connection request has changed. Start again.");
      return pending.operation;
    }
    const operation = (input.connectionId ? this.change(input.connectionId, () => this.startOnce(scope, input, fingerprint)) : this.startOnce(scope, input, fingerprint))
      .finally(() => this.starts.delete(key));
    this.starts.set(key, { fingerprint, operation });
    return operation;
  }

  private change<T>(id: string, action: () => Promise<T>): Promise<T> {
    const previous = this.changes.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(action).finally(() => {
      if (this.changes.get(id) === operation) this.changes.delete(id);
    });
    this.changes.set(id, operation);
    return operation;
  }

  private async startOnce(scope: RuntimeScope & { sessionId: string }, input: ConnectMcpInput, fingerprint: string): Promise<ConnectMcpResult> {
    const endpoint = connectionURL(input.endpoint).href;
    const previous = this.db!.prepare("SELECT * FROM mcp_connection_requests WHERE session_id=? AND request_id=?")
      .get(scope.sessionId, input.requestId) as { connection_id: string; fingerprint: string } | undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ConnectionError(409, "This connection request has changed. Start again.");
      const row = this.owned(scope, previous.connection_id);
      if (row.state === "authorized") return { id: row.id };
      const pending = this.db!.prepare("SELECT * FROM mcp_oauth_pending WHERE session_id=? AND request_id=?")
        .get(scope.sessionId, input.requestId) as PendingRow | undefined;
      if (pending && !pending.consumed && pending.expires_at > Date.now()) return { id: row.id, authorizationUrl: decryptSecret(pending.authorization_url, this.key) };
      throw new ConnectionError(409, "This connection attempt has ended. Start a new attempt.");
    }
    const existing = input.connectionId ? this.owned(scope, input.connectionId) : undefined;
    const priorCredential = existing ? this.credential(existing) : undefined;
    if (existing) {
      if (existing.endpoint !== endpoint || existing.authentication !== input.authentication) throw new ConnectionError(400, "Use a new connection for a different server or authentication method.");
      if (input.authentication === "oauth" && input.scopes?.length && JSON.stringify([...input.scopes].sort()) !== JSON.stringify((JSON.parse(existing.scopes) as string[]).sort())) {
        throw new ConnectionError(400, "Use a new connection to change its authorized scopes, then choose which agent instances receive it.");
      }
      await this.revokeOnce(scope, existing.id);
    }
    const id = existing?.id ?? randomUUID();
    const state = randomToken();
    let config: OAuthConfiguration | undefined;
    let credential: Credential = {};
    let authorization: { authorizationUrl: URL; codeVerifier: string } | undefined;
    if (input.authentication === "oauth") {
      const prepared = await prepareOAuth(endpoint, this.redirectURI, state, { ...input,
        scopes: existing ? JSON.parse(existing.scopes) as string[] : input.scopes,
        clientId: input.clientId ?? priorCredential?.client?.client_id,
        clientSecret: input.clientSecret ?? (!input.clientId || input.clientId === priorCredential?.client?.client_id ? priorCredential?.client?.client_secret : undefined),
        expectedIssuer: existing ? (JSON.parse(existing.config) as OAuthConfiguration).issuer : undefined });
      config = prepared.config; credential = { client: prepared.client }; authorization = prepared;
    } else if (input.authentication === "bearer") {
      credential.headers = { Authorization: `Bearer ${input.token}` };
    } else if (input.authentication === "headers") credential.headers = input.headers;
    const db = this.db!;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`INSERT INTO mcp_connections (id,company_id,owner_id,name,endpoint,state,authentication,provider,config,secret,scopes,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,state=excluded.state,config=excluded.config,
        secret=excluded.secret,scopes=excluded.scopes,error=NULL,refreshing=0,disconnect_notice=NULL`)
        .run(id, scope.companyId, scope.userId, input.name.trim(), endpoint, authorization ? "pending" : "authorized", input.authentication,
          existing?.provider ?? "", JSON.stringify(config ?? {}), encryptSecret(JSON.stringify(credential), this.key), JSON.stringify(config?.requestedScopes ?? []), Date.now());
      db.prepare("UPDATE mcp_oauth_pending SET consumed=1 WHERE connection_id=?").run(id);
      if (authorization) db.prepare("INSERT INTO mcp_oauth_pending VALUES (?,?,?,?,?,?,?,?,0)")
        .run(digest(state), id, scope.sessionId, encryptSecret(authorization.codeVerifier, this.key), Date.now() + 15 * 60_000,
          input.requestId, fingerprint, encryptSecret(authorization.authorizationUrl.href, this.key));
      db.prepare("INSERT INTO mcp_connection_requests VALUES (?,?,?,?)").run(scope.sessionId, input.requestId, id, fingerprint);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    return { id, ...(authorization ? { authorizationUrl: authorization.authorizationUrl.href } : {}) };
  }

  async complete(scope: RuntimeScope & { sessionId: string }, params: URLSearchParams) {
    const pending = this.db!.prepare("SELECT connection_id FROM mcp_oauth_pending WHERE state_hash=?")
      .get(digest(params.get("state") || "")) as { connection_id: string } | undefined;
    if (!pending) throw new ConnectionError(400, "This authorization has expired. Return to Dispatch and try again.");
    return this.change(pending.connection_id, () => this.completeOnce(scope, params));
  }

  private async completeOnce(scope: RuntimeScope & { sessionId: string }, params: URLSearchParams) {
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new ConnectionError(400, "The authorization response is invalid. Start again from Dispatch.");
    const pending = this.db!.prepare("SELECT * FROM mcp_oauth_pending WHERE state_hash=?").get(digest(params.get("state") || "")) as PendingRow | undefined;
    if (!pending || pending.session_id !== scope.sessionId || pending.expires_at <= Date.now()) throw new ConnectionError(400, "This authorization has expired or belongs to another session. Return to Dispatch and try again.");
    const row = this.owned(scope, pending.connection_id);
    const config = JSON.parse(row.config) as OAuthConfiguration;
    const issuer = params.get("iss");
    if ((issuer && connectionURL(issuer).href !== connectionURL(config.issuer).href) || (!issuer && config.metadata.authorization_response_iss_parameter_supported)) {
      throw new ConnectionError(400, "The authorization response did not match the expected issuer.");
    }
    if (pending.consumed) return { id: row.id, authorized: row.state === "authorized" };
    this.db!.prepare("UPDATE mcp_oauth_pending SET consumed=1 WHERE state_hash=?").run(pending.state_hash);
    if (params.has("error")) {
      this.mark(row.id, "error", "Authorization was cancelled or denied. You can try again when ready.");
      return { id: row.id, authorized: false };
    }
    if (!params.get("code")) throw new ConnectionError(400, "The authorization server did not return a code.");
    try {
      const credential = this.credential(row);
      if (!credential.client) throw new ConnectionError(400, "The OAuth client registration is missing. Start again.");
      credential.tokens = await exchangeCode(config, credential.client, params.get("code")!, decryptSecret(pending.verifier, this.key), this.redirectURI);
      this.saveCredential(row.id, credential);
      await this.verifyLegacy(row.id, credential.tokens.access_token);
      this.mark(row.id, "authorized", null);
      return { id: row.id, authorized: true };
    } catch {
      this.mark(row.id, "reauthorize", "Authorization could not be confirmed. Return to Dispatch and authorize again.");
      return { id: row.id, authorized: false };
    }
  }

  private saveCredential(id: string, credential: Credential) {
    this.db!.prepare("UPDATE mcp_connections SET secret=?,refreshing=0 WHERE id=?").run(encryptSecret(JSON.stringify(credential), this.key), id);
    if (credential.tokens) this.db!.prepare("UPDATE mcp_connections SET scopes=? WHERE id=?").run(JSON.stringify(credential.tokens.scope?.split(/\s+/).filter(Boolean) ?? []), id);
  }

  private mark(id: string, state: ConnectionAuthorizationState, error: string | null) {
    this.db!.prepare("UPDATE mcp_connections SET state=?,error=?,refreshing=0 WHERE id=?").run(state, error, id);
  }

  private async verifyLegacy(id: string, token: string) {
    const row = this.row(id);
    if (row.provider !== "agent-wiki") return;
    const info = await verifyLegacyWikiIdentity(row.endpoint, token, row.upstream_agent);
    this.db!.prepare("UPDATE mcp_connections SET upstream_agent=?,upstream_run=? WHERE id=?").run(info.agent, info.run, id);
  }

  async beforeConnect(id: string) {
    const row = this.row(id);
    if (row.state !== "authorized") throw new ConnectionError(401, row.error ?? "Connect this server in Settings → Connections.");
    if (row.provider === "agent-wiki") await this.verifyLegacy(id, (await this.token(id))!);
  }

  recordServer(id: string, name: string, instructions: string) {
    const row = this.row(id);
    this.db!.prepare("UPDATE mcp_connections SET server_name=?,identity=? WHERE id=?")
      .run(name, row.provider === "agent-wiki" ? legacyWikiIdentity(instructions, row.upstream_agent) : row.identity, id);
  }

  async token(id: string): Promise<string | undefined> {
    const row = this.row(id);
    if (row.state !== "authorized") throw new ConnectionError(401, row.error ?? "Connect this server in Settings → Connections.");
    if (row.authentication !== "oauth") return undefined;
    const credential = this.credential(row), tokens = credential.tokens;
    if (!tokens) throw new ConnectionError(401, "Authorize this connection again.");
    if (tokens.expiresAt === undefined || tokens.expiresAt > Date.now() + 30_000) return tokens.access_token;
    const active = this.renewals.get(id);
    if (active) return active;
    const renewal = this.renew(row, credential).finally(() => this.renewals.delete(id));
    this.renewals.set(id, renewal);
    return renewal;
  }

  private async renew(row: ConnectionRow, credential: Credential) {
    this.db!.prepare("UPDATE mcp_connections SET refreshing=1 WHERE id=?").run(row.id);
    try {
      if (!credential.tokens || !credential.client) throw new Error("Missing OAuth credentials");
      credential.tokens = await refreshTokens(JSON.parse(row.config) as OAuthConfiguration, credential.client, credential.tokens);
      // Preserve rotated tokens even if disconnect was requested while refreshing,
      // so revocation can revoke the current grant after awaiting this exchange.
      this.saveCredential(row.id, credential);
      if (this.row(row.id).state !== "authorized") throw new ConnectionError(401, "This connection was disconnected during renewal.");
      this.mark(row.id, "authorized", null);
      return credential.tokens.access_token;
    } catch (error) {
      if (this.row(row.id).state !== "authorized") throw new ConnectionError(401, "This connection was disconnected during renewal.");
      const failure = error instanceof RenewalError ? error : new RenewalError(false, "Credential renewal could not be saved. Authorize this connection again.");
      this.mark(row.id, failure.retryable ? "authorized" : "reauthorize", failure.message);
      throw failure;
    }
  }

  authProvider(id: string): AuthProvider {
    return { token: () => this.token(id), onUnauthorized: async ({ token, response }) => {
      const row = this.row(id);
      if (row.state !== "authorized") throw new ConnectionError(401, "This connection is disabled.");
      const challenge = extractWWWAuthenticateParams(response);
      if (row.authentication !== "oauth" || challenge.error === "insufficient_scope") {
        this.mark(id, "reauthorize", challenge.error === "insufficient_scope" ? "The server requires additional permissions. Create a connection with the required scopes." : "The server rejected these credentials. Update the connection in Settings.");
        throw new ConnectionError(401, "Update this connection in Settings → Connections.");
      }
      const credential = this.credential(row);
      if (token && credential.tokens?.access_token !== token) return;
      const active = this.renewals.get(id);
      if (active) { await active; return; }
      if (!credential.tokens) throw new ConnectionError(401, "Authorize this connection again.");
      credential.tokens.expiresAt = 0;
      this.saveCredential(id, credential);
      await this.token(id);
    } };
  }

  async fetch(id: string, input: string | URL, init?: RequestInit) {
    const row = this.row(id), url = connectionURL(input);
    if (row.state !== "authorized") throw new ConnectionError(401, "This connection is disabled.");
    if (url.href !== row.endpoint) throw new ConnectionError(400, "Connection credentials cannot be sent to a different endpoint.");
    const headers = new Headers(init?.headers);
    for (const [name, value] of Object.entries(this.credential(row).headers ?? {})) headers.set(name, value);
    return fetch(url, { ...init, headers, redirect: "error" });
  }

  revoke(scope: RuntimeScope, id: string) {
    this.owned(scope, id);
    return this.change(id, () => this.revokeOnce(scope, id));
  }

  private async revokeOnce(scope: RuntimeScope, id: string) {
    let row = this.owned(scope, id);
    this.db!.prepare("UPDATE mcp_oauth_pending SET consumed=1 WHERE connection_id=?").run(id);
    this.mark(id, "revoking", "Access is disabled in Dispatch. Disconnect is pending.");
    await this.renewals.get(id)?.catch(() => {});
    row = this.owned(scope, id);
    const credential = this.credential(row);
    let notice: string | null = null;
    if (row.authentication === "oauth" && credential.tokens && credential.client) {
      try {
        if (!await revokeTokens(JSON.parse(row.config) as OAuthConfiguration, credential.client, credential.tokens)) {
          notice = "Disconnected locally. This server does not advertise token revocation; revoke access in the provider's settings if needed.";
        }
      } catch { throw new ConnectionError(502, "Dispatch access is disabled, but server revocation could not be confirmed. Retry disconnecting."); }
    } else if (row.authentication === "bearer" || row.authentication === "headers") {
      notice = "Credentials were removed from Dispatch. Revoke the token or API key with its provider if needed.";
    }
    this.db!.prepare("UPDATE mcp_connections SET secret=NULL,state='revoked',error=NULL,refreshing=0,disconnect_notice=? WHERE id=?").run(notice, id);
  }

  async close() {
    await Promise.allSettled([...this.changes.values(), ...this.renewals.values(), ...[...this.starts.values()].map(start => start.operation)]);
    this.db?.close();
  }
}
