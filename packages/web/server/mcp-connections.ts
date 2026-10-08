import { createHmac, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AuthProvider } from "@earendil-works/pi-mcp";
import type { OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { extractWWWAuthenticateParams } from "@modelcontextprotocol/sdk/client/auth.js";
import type { ConnectMcpInput, ConnectMcpResult, ConnectionAuthentication, ConnectionAuthorizationState, RuntimeScope } from "../src/shared/contracts.js";
import { decryptSecret, digest, encryptSecret, loadSecretKey, randomToken } from "./auth/crypto.js";
import { ConnectionError, connectionURL, exchangeCode, prepareOAuth, refreshTokens, revokeTokens, type OAuthConfiguration, type StoredTokens } from "./mcp-oauth.js";
import { legacyWikiIdentity, verifyLegacyWikiIdentity } from "./legacy-wiki-connection.js";
import { McpDatabase, MCP_SCHEMA, type ConnectionRow, type McpPostgresOptions } from "./storage/mcp-database.js";
import { decryptMcpSecret, encryptMcpSecret } from "./storage/mcp-secrets.js";

export { ConnectionError } from "./mcp-oauth.js";
type Credential = { tokens?: StoredTokens; client?: OAuthClientInformationMixed; headers?: Record<string, string> };
type PendingRow = { state_hash: string; connection_id: string; session_id: string; verifier: string; expires_at: number; request_id: string; fingerprint: string; authorization_url: string; consumed: number };
export type ManagedConnectionRecord = {
  id: string; companyId: string; ownerId: string; name: string; endpoint: string;
  authentication: ConnectionAuthentication; authorization: ConnectionAuthorizationState; identity: string; serverName: string;
  scopes: string[]; createdAt: number; error?: string; disconnectNotice?: string;
};

export class McpConnections {
  private db?: McpDatabase;
  private installation?: string;
  private accepting = true;
  private generation = 0;
  private readonly active = new Set<Promise<unknown>>();
  private readonly denied = new Map<string, number>();
  private draining?: Promise<void>;
  private closing?: Promise<void>;
  private key!: Buffer;
  private readonly renewals = new Map<string, Promise<string | undefined>>();
  private readonly starts = new Map<string, { fingerprint: string; operation: Promise<ConnectMcpResult> }>();
  private readonly changes = new Map<string, Promise<unknown>>();
  readonly redirectURI: string;

  constructor(private readonly databasePath: string, private readonly keyPath: string, origin: string) {
    this.redirectURI = origin + "/api/connections/oauth/callback";
  }

  /** Opens locally quiesced. Integration applies persisted drain before resume(). */
  static async openPostgres(options: McpPostgresOptions & { origin: string }) {
    const connections = new McpConnections("", "", options.origin);
    connections.installation = options.installationId;
    connections.key = Buffer.from(options.encryptionKey);
    connections.accepting = false;
    try { connections.db = await McpDatabase.openPostgres(options); return connections; }
    catch (error) { connections.key.fill(0); throw error; }
  }

  get ownerId() { return this.db?.ownerId; }
  get admitting() { return this.accepting && !this.closing && !!this.db?.healthy; }
  get quiesced() { return !this.accepting && this.active.size === 0 && !!this.db?.healthy; }

  private admit<T>(action: () => Promise<T>): Promise<T> {
    if (!this.admitting) return Promise.reject(new ConnectionError(503, "MCP credential operations are unavailable or quiesced."));
    const operation = Promise.resolve().then(action);
    this.active.add(operation);
    void operation.then(() => this.active.delete(operation), () => this.active.delete(operation));
    return operation;
  }

  private deny<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.denied.set(id, (this.denied.get(id) ?? 0) + 1);
    return action().finally(() => {
      const remaining = this.denied.get(id)! - 1;
      if (remaining) this.denied.set(id, remaining); else this.denied.delete(id);
    });
  }

  private authorized(row: ConnectionRow) { return row.state === "authorized" && !this.denied.has(row.id); }
  private binding(row: Pick<ConnectionRow, "id" | "company_id" | "owner_id" | "endpoint" | "authentication">) {
    return ["connection", row.company_id, row.owner_id, row.id, row.endpoint, row.authentication];
  }
  private pendingBinding(row: ConnectionRow, pending: PendingRow, purpose: string) {
    return [...this.binding(row), "attempt", pending.session_id, pending.request_id, pending.state_hash, pending.fingerprint, String(pending.expires_at), purpose];
  }
  private seal(value: string, binding: string[]) {
    return this.installation ? encryptMcpSecret(value, this.key, [this.installation, ...binding]) : encryptSecret(value, this.key);
  }
  private unseal(value: string, binding: string[]) {
    return this.installation ? decryptMcpSecret(value, this.key, [this.installation, ...binding]) : decryptSecret(value, this.key);
  }

  // Called only after the runtime has acquired the installation's owner lock.
  initialize() {
    if (this.db) { this.db.assertHealthy(); return; }
    mkdirSync(dirname(this.databasePath), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.databasePath);
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
      db.exec(MCP_SCHEMA);
      this.key = loadSecretKey(this.keyPath, Boolean(db.prepare("SELECT 1 FROM mcp_connections WHERE secret IS NOT NULL UNION SELECT 1 FROM mcp_oauth_pending LIMIT 1").get()));
      if (legacy) {
        for (const row of db.prepare("SELECT * FROM mcp_connections").all() as ConnectionRow[]) {
          const old = JSON.parse(row.config) as { issuer: string; clientId: string; authorize: string; token: string; revoke: string };
          const requestedScopes = JSON.parse(row.scopes) as string[];
          const config: OAuthConfiguration = { issuer: old.issuer, resource: row.endpoint, requestedScopes,
            metadata: { issuer: old.issuer, authorization_endpoint: old.authorize, token_endpoint: old.token, revocation_endpoint: old.revoke,
              response_types_supported: ["code"], code_challenge_methods_supported: ["S256"], authorization_response_iss_parameter_supported: true } };
          const credential: Credential = { client: { client_id: old.clientId, issuer: old.issuer },
            ...(row.secret ? { tokens: { ...JSON.parse(this.unseal(row.secret, this.binding(row))) as StoredTokens, issuer: old.issuer } } : {}) };
          db.prepare("UPDATE mcp_connections SET config=?,secret=? WHERE id=?").run(JSON.stringify(config), encryptSecret(JSON.stringify(credential), this.key), row.id);
        }
      }
      db.prepare("UPDATE mcp_connections SET state='reauthorize',refreshing=0,error=? WHERE refreshing=1")
        .run("Credential renewal was interrupted. Authorize this connection again.");
      db.prepare(`UPDATE mcp_connections SET state='reauthorize',error=? WHERE state='pending' AND NOT EXISTS
        (SELECT 1 FROM mcp_oauth_pending WHERE connection_id=mcp_connections.id AND consumed=0 AND expires_at>?)`)
        .run("Authorization was interrupted or expired. Authorize this connection again.", Date.now());
      db.exec("COMMIT");
      this.db = McpDatabase.sqlite(db);
    } catch (error) { try { db.exec("ROLLBACK"); } finally { db.close(); this.key?.fill(0); } throw error; }
  }

  private row(id: string): ConnectionRow {
    const row = this.db!.row(id);
    if (!row) throw new ConnectionError(404, "Connection not found.");
    return row;
  }

  private owned(scope: RuntimeScope, id: string) {
    const row = this.row(id);
    if (row.company_id !== scope.companyId || row.owner_id !== scope.userId) throw new ConnectionError(404, "Connection not found.");
    return row;
  }

  private credential(row: ConnectionRow): Credential {
    return row.secret ? JSON.parse(this.unseal(row.secret, this.binding(row))) as Credential : {};
  }

  record(id: string): ManagedConnectionRecord {
    const row = this.row(id);
    return { id: row.id, companyId: row.company_id, ownerId: row.owner_id, name: row.name, endpoint: row.endpoint,
      authentication: row.authentication, authorization: this.denied.has(id) ? "revoking" : row.state, identity: row.identity, serverName: row.server_name,
      scopes: JSON.parse(row.scopes) as string[], createdAt: row.created_at, ...(row.error ? { error: row.error } : {}),
      ...(row.disconnect_notice ? { disconnectNotice: row.disconnect_notice } : {}) };
  }

  list(companyId: string) {
    return this.db!.list().filter(row => row.company_id === companyId).sort((a, b) => b.created_at - a.created_at).map(({ id }) => this.record(id));
  }

  requireAssignment(scope: RuntimeScope, id: string) {
    if (!this.admitting || !this.authorized(this.owned(scope, id))) throw new ConnectionError(409, "Finish connecting the server before adding it to an agent.");
  }

  start(scope: RuntimeScope & { sessionId: string }, input: ConnectMcpInput) {
    if (input.connectionId) {
      this.owned(scope, input.connectionId);
      return this.deny(input.connectionId, () => this.admit(() => this.startAdmitted(scope, input)));
    }
    return this.admit(() => this.startAdmitted(scope, input));
  }

  private startAdmitted(scope: RuntimeScope & { sessionId: string }, input: ConnectMcpInput) {
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
    const [previous] = await this.db!.read<{ connection_id: string; fingerprint: string }>(
      "SELECT * FROM mcp_connection_requests WHERE session_id=$1 AND request_id=$2", [scope.sessionId, input.requestId]);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new ConnectionError(409, "This connection request has changed. Start again.");
      const row = this.owned(scope, previous.connection_id);
      if (row.state === "authorized") return { id: row.id };
      const [pending] = await this.db!.read<PendingRow>("SELECT * FROM mcp_oauth_pending WHERE session_id=$1 AND request_id=$2", [scope.sessionId, input.requestId]);
      if (pending && !pending.consumed && pending.expires_at > Date.now()) return { id: row.id, authorizationUrl: this.unseal(pending.authorization_url, this.pendingBinding(row, pending, "url")) };
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
    const binding = { id, company_id: scope.companyId, owner_id: scope.userId, endpoint, authentication: input.authentication };
    const pending: PendingRow = { state_hash: digest(state), connection_id: id, session_id: scope.sessionId,
      verifier: "", expires_at: Date.now() + 15 * 60_000, request_id: input.requestId, fingerprint,
      authorization_url: "", consumed: 0 };
    await this.db!.write([id], async query => {
      await query(`INSERT INTO mcp_connections (id,company_id,owner_id,name,endpoint,state,authentication,provider,config,secret,scopes,created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT(id) DO UPDATE SET name=excluded.name,state=excluded.state,config=excluded.config,
        secret=excluded.secret,scopes=excluded.scopes,error=NULL,refreshing=0,disconnect_notice=NULL`,
        [id, scope.companyId, scope.userId, input.name.trim(), endpoint, authorization ? "pending" : "authorized", input.authentication,
          existing?.provider ?? "", JSON.stringify(config ?? {}), this.seal(JSON.stringify(credential), this.binding(binding)), JSON.stringify(config?.requestedScopes ?? []), Date.now()]);
      await query("UPDATE mcp_oauth_pending SET consumed=1 WHERE connection_id=$1", [id]);
      if (authorization) {
        const context = [...this.binding(binding), "attempt", pending.session_id, pending.request_id, pending.state_hash, pending.fingerprint, String(pending.expires_at)];
        await query("INSERT INTO mcp_oauth_pending VALUES ($1,$2,$3,$4,$5,$6,$7,$8,0)",
          [pending.state_hash, id, scope.sessionId, this.seal(authorization.codeVerifier, [...context, "verifier"]), pending.expires_at,
            input.requestId, fingerprint, this.seal(authorization.authorizationUrl.href, [...context, "url"])]);
      }
      await query("INSERT INTO mcp_connection_requests VALUES ($1,$2,$3,$4)", [scope.sessionId, input.requestId, id, fingerprint]);
    });
    return { id, ...(authorization ? { authorizationUrl: authorization.authorizationUrl.href } : {}) };
  }

  complete(scope: RuntimeScope & { sessionId: string }, params: URLSearchParams) {
    return this.admit(async () => {
      const [pending] = await this.db!.read<{ connection_id: string }>("SELECT connection_id FROM mcp_oauth_pending WHERE state_hash=$1", [digest(params.get("state") || "")]);
      if (!pending) throw new ConnectionError(400, "This authorization has expired. Return to Dispatch and try again.");
      return this.change(pending.connection_id, () => this.completeOnce(scope, params));
    });
  }

  private async completeOnce(scope: RuntimeScope & { sessionId: string }, params: URLSearchParams) {
    for (const key of params.keys()) if (params.getAll(key).length !== 1) throw new ConnectionError(400, "The authorization response is invalid. Start again from Dispatch.");
    const [pending] = await this.db!.read<PendingRow>("SELECT * FROM mcp_oauth_pending WHERE state_hash=$1", [digest(params.get("state") || "")]);
    if (!pending || pending.session_id !== scope.sessionId || pending.expires_at <= Date.now()) throw new ConnectionError(400, "This authorization has expired or belongs to another session. Return to Dispatch and try again.");
    const row = this.owned(scope, pending.connection_id);
    const config = JSON.parse(row.config) as OAuthConfiguration;
    const issuer = params.get("iss");
    if ((issuer && connectionURL(issuer).href !== connectionURL(config.issuer).href) || (!issuer && config.metadata.authorization_response_iss_parameter_supported)) {
      throw new ConnectionError(400, "The authorization response did not match the expected issuer.");
    }
    if (pending.consumed) return { id: row.id, authorized: this.authorized(row) };
    await this.db!.write([row.id], query => query("UPDATE mcp_oauth_pending SET consumed=1 WHERE state_hash=$1", [pending.state_hash]));
    if (params.has("error")) {
      await this.mark(row.id, "error", "Authorization was cancelled or denied. You can try again when ready.");
      return { id: row.id, authorized: false };
    }
    if (!params.get("code")) throw new ConnectionError(400, "The authorization server did not return a code.");
    try {
      const credential = this.credential(row);
      if (!credential.client) throw new ConnectionError(400, "The OAuth client registration is missing. Start again.");
      credential.tokens = await exchangeCode(config, credential.client, params.get("code")!, this.unseal(pending.verifier, this.pendingBinding(row, pending, "verifier")), this.redirectURI);
      await this.saveCredential(row.id, credential);
      await this.verifyLegacy(row.id, credential.tokens.access_token);
      await this.mark(row.id, "authorized", null);
      return { id: row.id, authorized: this.authorized(this.row(row.id)) };
    } catch {
      await this.mark(row.id, "reauthorize", "Authorization could not be confirmed. Return to Dispatch and authorize again.");
      return { id: row.id, authorized: false };
    }
  }

  private async saveCredential(id: string, credential: Credential) {
    const row = this.row(id);
    await this.db!.write([id], async query => {
      await query("UPDATE mcp_connections SET secret=$1,refreshing=0 WHERE id=$2", [this.seal(JSON.stringify(credential), this.binding(row)), id]);
      if (credential.tokens) await query("UPDATE mcp_connections SET scopes=$1 WHERE id=$2", [JSON.stringify(credential.tokens.scope?.split(/\s+/).filter(Boolean) ?? []), id]);
    });
  }

  private async mark(id: string, state: ConnectionAuthorizationState, error: string | null) {
    await this.db!.write([id], query => query("UPDATE mcp_connections SET state=$1,error=$2,refreshing=0 WHERE id=$3", [state, error, id]));
  }

  private async verifyLegacy(id: string, token: string) {
    const row = this.row(id);
    if (row.provider !== "agent-wiki") return;
    const info = await verifyLegacyWikiIdentity(row.endpoint, token, row.upstream_agent);
    await this.db!.write([id], query => query("UPDATE mcp_connections SET upstream_agent=$1,upstream_run=$2 WHERE id=$3", [info.agent, info.run, id]));
  }

  beforeConnect(id: string) {
    return this.admit(async () => {
      const row = this.row(id);
      if (!this.authorized(row)) throw new ConnectionError(401, "Connect this server in Settings → Connections.");
      if (row.provider === "agent-wiki") await this.verifyLegacy(id, (await this.tokenOnce(id))!);
    });
  }

  recordServer(id: string, name: string, instructions: string): Promise<void> {
    return this.admit(async () => {
      const row = this.row(id);
      await this.db!.write([id], query => query("UPDATE mcp_connections SET server_name=$1,identity=$2 WHERE id=$3",
        [name, row.provider === "agent-wiki" ? legacyWikiIdentity(instructions, row.upstream_agent) : row.identity, id]));
    });
  }

  token(id: string): Promise<string | undefined> { return this.admit(() => this.tokenOnce(id)); }

  private async tokenOnce(id: string): Promise<string | undefined> {
    const row = this.row(id);
    if (!this.authorized(row)) throw new ConnectionError(401, "Connect this server in Settings → Connections.");
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
    await this.db!.write([row.id], query => query("UPDATE mcp_connections SET refreshing=1 WHERE id=$1", [row.id]));
    try {
      if (!credential.tokens || !credential.client) throw new Error("Missing OAuth credentials");
      credential.tokens = await refreshTokens(JSON.parse(row.config) as OAuthConfiguration, credential.client, credential.tokens);
      // Preserve rotated tokens even if disconnect was requested while refreshing,
      // so revocation can revoke the current grant after awaiting this exchange.
      await this.saveCredential(row.id, credential);
      if (!this.authorized(this.row(row.id))) throw new ConnectionError(401, "This connection was disconnected during renewal.");
      return credential.tokens.access_token;
    } catch {
      if (this.authorized(this.row(row.id))) await this.mark(row.id, "reauthorize", "Credential renewal could not be confirmed. Authorize this connection again.");
      throw new ConnectionError(401, "This connection needs authorization again.");
    }
  }

  authProvider(id: string): AuthProvider {
    return { token: () => this.token(id), onUnauthorized: ({ token, response }) => this.admit(() => this.change(id, async () => {
      const row = this.row(id);
      if (!this.authorized(row)) throw new ConnectionError(401, "This connection is disabled.");
      const challenge = extractWWWAuthenticateParams(response);
      if (row.authentication !== "oauth" || challenge.error === "insufficient_scope") {
        await this.mark(id, "reauthorize", challenge.error === "insufficient_scope" ? "The server requires additional permissions. Create a connection with the required scopes." : "The server rejected these credentials. Update the connection in Settings.");
        throw new ConnectionError(401, "Update this connection in Settings → Connections.");
      }
      const credential = this.credential(row);
      if (token && credential.tokens?.access_token !== token) return;
      const active = this.renewals.get(id);
      if (active) { await active; return; }
      if (!credential.tokens) throw new ConnectionError(401, "Authorize this connection again.");
      credential.tokens.expiresAt = 0;
      await this.saveCredential(id, credential);
      await this.tokenOnce(id);
    })) };
  }

  fetch(id: string, input: string | URL, init?: RequestInit) {
    return this.admit(async () => {
      const row = this.row(id), url = connectionURL(input);
      if (!this.authorized(row)) throw new ConnectionError(401, "This connection is disabled.");
      if (url.href !== row.endpoint) throw new ConnectionError(400, "Connection credentials cannot be sent to a different endpoint.");
      const headers = new Headers(init?.headers);
      for (const [name, value] of Object.entries(this.credential(row).headers ?? {})) headers.set(name, value);
      return fetch(url, { ...init, headers, redirect: "error" });
    });
  }

  revoke(scope: RuntimeScope, id: string) {
    this.owned(scope, id);
    return this.deny(id, () => this.admit(() => this.change(id, () => this.revokeOnce(scope, id))));
  }

  private async revokeOnce(scope: RuntimeScope, id: string) {
    let row = this.owned(scope, id);
    await this.db!.write([id], async query => {
      await query("UPDATE mcp_oauth_pending SET consumed=1 WHERE connection_id=$1", [id]);
      await query("UPDATE mcp_connections SET state='revoking',error=$1,refreshing=0 WHERE id=$2", ["Access is disabled in Dispatch. Disconnect is pending.", id]);
    });
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
    await this.db!.write([id], query => query("UPDATE mcp_connections SET secret=NULL,state='revoked',error=NULL,refreshing=0,disconnect_notice=$1 WHERE id=$2", [notice, id]));
  }

  quiesce(): Promise<void> {
    this.accepting = false;
    this.generation++;
    this.draining ??= Promise.allSettled([...this.active]).then(async () => { await this.db?.flush(); });
    return this.draining;
  }

  async resume(): Promise<void> {
    if (this.closing) throw new ConnectionError(503, "MCP connections are closing.");
    const generation = ++this.generation;
    await this.draining;
    this.db!.assertHealthy();
    if (this.closing) throw new ConnectionError(503, "MCP connections are closing.");
    if (generation === this.generation) { this.draining = undefined; this.accepting = true; }
  }

  close(): Promise<void> {
    if (!this.closing) {
      const drained = this.quiesce();
      this.closing = (async () => {
        try { await drained; }
        finally { try { await this.db?.close(); } finally { this.key?.fill(0); } }
      })();
    }
    return this.closing;
  }
}
