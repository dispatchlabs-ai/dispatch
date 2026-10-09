import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransport,
  type RegistrationResponseJSON,
  type VerifiedRegistrationResponse,
} from "@simplewebauthn/server";
import type {
  AuthenticatedState,
  AuthState,
  AuthUser,
  EnrollmentState,
  SecurityState,
} from "../src/shared/auth-contracts.js";
import type { CompanyPerson } from "../src/shared/contracts.js";
import {
  decryptSecret,
  digest,
  encryptSecret,
  hashPassword,
  loadSecretKey,
  matchTotpStep,
  newRecoveryCodes,
  newTotp,
  normalizeRecoveryCode,
  randomToken,
  verifyPassword,
} from "./auth/crypto.js";
import { AuthStore, type AsyncAuthStore } from "./auth/store.js";
import { PostgresAuthStore } from "./auth/postgres.js";
import type { ClientConfig } from "pg";

const MINUTE = 60_000;
const SESSION_LIFETIME = 12 * 60 * MINUTE;
const SESSION_IDLE = 30 * MINUTE;
const FRESH_AUTH = 10 * MINUTE;
const CHALLENGE_LIFETIME = 5 * MINUTE;
const ENROLLMENT_LIFETIME = 15 * MINUTE;
const MAX_JSON_BYTES = 64 * 1024;

export interface AuthConfig {
  databasePath: string;
  secretPath: string;
  origin: string;
  rpId: string;
  companyId: string;
  companyName?: string;
}

export type AuthIdentityConfig = Omit<AuthConfig, "databasePath" | "secretPath">;
export interface PostgresAuthConfig extends AuthIdentityConfig {
  database: ClientConfig;
  installationId: string;
  encryptionKey: Buffer;
}

export interface AuthPrincipal {
  userId: string;
  companyId: string;
  sessionId: string;
  email: string;
  name: string;
  expiresAt: number;
}

export interface InvitationInput {
  email: string;
  name?: string;
  expiresInMs?: number;
}

export interface Invitation {
  token: string;
  url: string;
  expiresAt: number;
}

interface UserRow {
  id: string;
  company_id: string;
  email: string;
  name: string;
  status: "invited" | "active" | "recovery";
  password_hash: string | null;
  totp_secret: string | null;
  totp_last_step: number;
  credential_version: number;
}

interface SessionRow {
  id: string;
  token_hash: string;
  user_id: string;
  credential_version: number;
  created_at: number;
  expires_at: number;
  last_seen_at: number;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  name: string;
  public_key: string;
  counter: number;
  transports: string;
  created_at: number;
}

type PendingPurpose = "password" | "enrollment" | "passkey_login" | "security_passkey" | "security_totp";

interface PendingData {
  passkeyName?: string;
  reason?: "invitation" | "recovery";
  name?: string;
  passwordHash?: string;
  totpSecret?: string;
  sessionId?: string;
  challenge?: string;
  challengeExpiresAt?: number;
}

interface PendingRow {
  token_hash: string;
  user_id: string | null;
  purpose: PendingPurpose;
  credential_version: number | null;
  data: string;
  expires_at: number;
}

interface Pending extends Omit<PendingRow, "data"> {
  data: PendingData;
}

class AuthError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const invalidAuthentication = () => new AuthError(401, "AUTHENTICATION_FAILED", "The credentials or verification code were not accepted.");
const expiredFlow = () => new AuthError(401, "FLOW_EXPIRED", "This authentication step has expired. Start again.");

function stringField(body: Record<string, unknown>, key: string, maximum = 1024): string {
  const value = body[key];
  if (typeof value !== "string" || !value || value.length > maximum) {
    throw new AuthError(400, "INVALID_INPUT", `Provide a valid ${key}.`);
  }
  return value;
}

function emailAddress(value: string): string {
  const email = value.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new AuthError(400, "INVALID_INPUT", "Provide a valid email address.");
  }
  return email;
}

function displayName(value: string): string {
  const name = value.trim();
  if (!name || name.length > 100) throw new AuthError(400, "INVALID_INPUT", "Use a name between 1 and 100 characters.");
  return name;
}

function newPassword(body: Record<string, unknown>): string {
  const password = stringField(body, "password", 128);
  if ([...password].length < 12) throw new AuthError(400, "PASSWORD_TOO_SHORT", "Use a password with at least 12 characters.");
  return password;
}

function publicUser(user: UserRow): AuthUser {
  return { id: user.id, email: user.email, name: user.name, companyId: user.company_id };
}

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie")?.split(";").find((part) => part.trim().startsWith(`${name}=`));
  const value = cookie?.trim().slice(name.length + 1);
  return value && /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
    throw new AuthError(415, "JSON_REQUIRED", "Send an application/json request.");
  }
  const reader = request.body?.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_JSON_BYTES) {
        await reader.cancel();
        throw new AuthError(413, "REQUEST_TOO_LARGE", "The authentication request is too large.");
      }
      chunks.push(value);
    }
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as Record<string, unknown>;
  } catch {
    throw new AuthError(400, "INVALID_JSON", "Send a JSON object.");
  }
}

export async function createAuth(config: AuthConfig): Promise<AuthService> {
  return AuthService.open(config);
}

export class AuthService {
  private readonly operations = new Set<Promise<unknown>>();
  private readonly operationContext = new AsyncLocalStorage<{ active: boolean }>();
  private accepting = true;
  private lifecycleGeneration = 0;
  private closing?: Promise<void>;

  private readonly now = Date.now;
  private lastCleanup = this.now();
  private readonly origin: string;
  private readonly secure: boolean;
  private readonly sessionCookie: string;
  private readonly pendingCookie: string;
  private readonly revocationListeners = new Set<() => void | Promise<void>>();

  private constructor(private readonly config: AuthIdentityConfig, private readonly store: AsyncAuthStore, private readonly key: Buffer) {
    const origin = new URL(config.origin);
    if (origin.origin !== config.origin || origin.username || origin.password) throw new Error("Authentication origin must be an exact origin without a path.");
    this.secure = origin.protocol === "https:";
    if (!this.secure && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) {
      throw new Error("Authentication requires HTTPS outside loopback development.");
    }
    const hostname = origin.hostname.replace(/^\[|\]$/g, "");
    if (hostname !== config.rpId && !hostname.endsWith(`.${config.rpId}`)) throw new Error("The WebAuthn relying-party ID must match the application origin.");
    if (!config.companyId.trim()) throw new Error("A company ID is required for this installation.");
    this.origin = origin.origin;
    this.sessionCookie = this.secure ? "__Host-dispatch-session" : "dispatch-session";
    this.pendingCookie = this.secure ? "__Host-dispatch-pending" : "dispatch-pending";
  }

  static async open(config: AuthConfig): Promise<AuthService> {
    const store = new AuthStore(config.databasePath);
    let key: Buffer | undefined;
    try {
      const encryptedState = await store.one<{ present: number }>(`SELECT
        EXISTS(SELECT 1 FROM auth_users WHERE totp_secret IS NOT NULL)
        OR EXISTS(SELECT 1 FROM auth_pending WHERE data LIKE '%"totpSecret"%') AS present`);
      key = loadSecretKey(config.secretPath, !!encryptedState?.present);
      const service = new AuthService(config, store, key);
      await service.removeExpiredState();
      return service;
    } catch (error) {
      key?.fill(0);
      await store.close();
      throw error;
    }
  }

  static async openPostgres(config: PostgresAuthConfig): Promise<AuthService> {
    if (config.encryptionKey.length !== 32) throw new Error("Authentication encryption key must be exactly 32 bytes");
    const key = Buffer.from(config.encryptionKey);
    let store: PostgresAuthStore | undefined;
    try {
      store = await PostgresAuthStore.open({
        database: config.database, installationId: config.installationId, companyId: config.companyId,
        keyFingerprint: createHash("sha256").update(key).digest("hex"),
      });
      const service = new AuthService(config, store, key);
      service.accepting = false;
      return service;
    } catch (error) {
      key.fill(0);
      await store?.close();
      throw error;
    }
  }

  get admitting(): boolean { return this.accepting && !this.closing; }

  private admit<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationContext.getStore()?.active) return operation();
    if (!this.admitting) return Promise.reject(new Error("Authentication admission is closed"));
    const scope = { active: true };
    const result = this.operationContext.run(scope, operation);
    this.operations.add(result);
    void result.finally(() => { scope.active = false; this.operations.delete(result); }).catch(() => { });
    return result;
  }

  async quiesce(): Promise<void> {
    ++this.lifecycleGeneration;
    this.accepting = false;
    await Promise.allSettled([...this.operations]);
  }

  async resume(): Promise<void> {
    if (this.closing) throw new Error("Authentication service is closing");
    const generation = ++this.lifecycleGeneration;
    this.accepting = false;
    await Promise.allSettled([...this.operations]);
    if (generation !== this.lifecycleGeneration) return;
    await this.store.one("SELECT 1");
    if (this.closing) throw new Error("Authentication service is closing");
    // A later drain or resume supersedes this attempt, including while SQL awaited.
    if (generation === this.lifecycleGeneration) this.accepting = true;
  }

  close(): Promise<void> {
    if (!this.closing) this.closing = (async () => {
      await this.quiesce();
      this.revocationListeners.clear();
      try { await this.store.close(); } finally { this.key.fill(0); }
    })();
    return this.closing;
  }

  onRevocation(listener: () => void | Promise<void>): () => void {
    this.revocationListeners.add(listener);
    return () => this.revocationListeners.delete(listener);
  }

  private async notifyRevocation(): Promise<void> {
    const results = await Promise.allSettled([...this.revocationListeners].map(async listener => listener()));
    const failures = results.filter(result => result.status === "rejected");
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), "Session revocation cleanup failed");
  }

  private async removeExpiredState(): Promise<void> {
    return this.store.transaction(async () => {
      const now = this.now();
      await this.store.run("DELETE FROM auth_pending WHERE expires_at <= ?", now);
      await this.store.run("DELETE FROM auth_invitations WHERE expires_at <= ?", now);
      await this.store.run("DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ?", now, now - SESSION_IDLE);
      await this.store.run("DELETE FROM auth_rate_limits WHERE starts_at < ?", now - 5 * MINUTE);
    });
  }

  private async user(id: string): Promise<UserRow | undefined> {
    return await this.store.one<UserRow>("SELECT * FROM auth_users WHERE id = ? AND company_id = ?", id, this.config.companyId);
  }

  private async findUser(email: string): Promise<UserRow | undefined> {
    return await this.store.one<UserRow>("SELECT * FROM auth_users WHERE email = ? AND company_id = ?", email, this.config.companyId);
  }

  private async currentUser(user: UserRow, requiredStatus = user.status): Promise<UserRow> {
    return this.store.transaction(async () => {
      const current = await this.user(user.id);
      if (!current || current.status !== requiredStatus || current.credential_version !== user.credential_version) throw expiredFlow();
      return current;
    });
  }

  private async session(id: string): Promise<{ user: UserRow; session: SessionRow } | null> {
    return this.store.transaction(async () => {
      const session = await this.store.one<SessionRow>("SELECT * FROM auth_sessions WHERE id = ?", id);
      if (!session || session.expires_at <= this.now() || session.last_seen_at + SESSION_IDLE <= this.now()) return null;
      const user = await this.user(session.user_id);
      if (!user || user.status !== "active" || user.credential_version !== session.credential_version) return null;
      return { user, session };
    });
  }

  async authenticate(request: Request): Promise<AuthPrincipal | null> {
    return this.admit(async () => {
      return this.store.transaction(async () => {
        const token = cookieValue(request, this.sessionCookie);
        if (!token) return null;
        const row = await this.store.one<{ id: string }>("SELECT id FROM auth_sessions WHERE token_hash = ?", digest(token));
        const valid = row ? await this.session(row.id) : null;
        if (!valid) return null;
        await this.store.run("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?", this.now(), valid.session.id);
        return {
          userId: valid.user.id,
          companyId: valid.user.company_id,
          email: valid.user.email,
          name: valid.user.name,
          sessionId: valid.session.id,
          expiresAt: valid.session.expires_at,
        };
      });
    });
  }

  async isSessionValid(sessionId: string): Promise<boolean> {
    return this.admit(async () => {
      return (await this.session(sessionId)) !== null;
    });
  }

  async listCompanyPeople(companyId: string): Promise<CompanyPerson[]> {
    return this.admit(async () => {
      return await this.store.all<CompanyPerson>(
        "SELECT id, name FROM auth_users WHERE company_id = ? AND status = 'active' ORDER BY name COLLATE NOCASE, id",
        companyId,
      );
    });
  }

  async getCompanyPerson(companyId: string, userId: string): Promise<CompanyPerson | null> {
    return this.admit(async () => {
      return (await this.store.one<CompanyPerson>(
        "SELECT id, name FROM auth_users WHERE company_id = ? AND id = ? AND status = 'active'",
        companyId, userId,
      )) ?? null;
    });
  }

  async revokeSession(sessionId: string): Promise<void> {
    return this.admit(async () => {
      if (await this.store.run("DELETE FROM auth_sessions WHERE id = ?", sessionId)) await this.notifyRevocation();
    });
  }

  async issueInvitation(input: InvitationInput): Promise<Invitation> {
    return this.admit(async () => {
      return await this.issueEnrollmentInvitation(input, false);
    });
  }

  /** Operator-only recovery after independently establishing the account owner's identity. */
  async issueRecoveryInvitation(input: InvitationInput): Promise<Invitation> {
    return this.admit(async () => {
      return await this.issueEnrollmentInvitation(input, true);
    });
  }

  private async issueEnrollmentInvitation(input: InvitationInput, recovery: boolean): Promise<Invitation> {
    const email = emailAddress(input.email);
    const name = displayName(input.name ?? email);
    const lifetime = input.expiresInMs ?? 60 * MINUTE;
    if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > 24 * 60 * MINUTE) throw new Error("Invitation lifetime must be between one millisecond and 24 hours.");
    const token = randomToken();
    const expiresAt = this.now() + lifetime;
    await this.store.transaction(async () => {
      let user = await this.findUser(email);
      if (recovery && !user) throw new Error("No account exists for that email address.");
      if (!recovery && user && user.status !== "invited") throw new Error("That account already exists; use the explicit recovery command after verifying its owner.");
      if (!user) {
        const id = randomBytes(16).toString("base64url");
        await this.store.run("INSERT INTO auth_users (id, company_id, email, name, status) VALUES (?, ?, ?, ?, 'invited')", id, this.config.companyId, email, name);
        user = (await this.user(id))!;
      } else if (input.name !== undefined) {
        await this.store.run("UPDATE auth_users SET name = ? WHERE id = ?", name, user.id);
      }
      await this.store.run("DELETE FROM auth_invitations WHERE user_id = ?", user.id);
      await this.store.run("DELETE FROM auth_pending WHERE user_id = ?", user.id);
      if (recovery) {
        await this.store.run("DELETE FROM auth_sessions WHERE user_id = ?", user.id);
        await this.store.run("DELETE FROM auth_recovery_codes WHERE user_id = ?", user.id);
        await this.store.run("UPDATE auth_users SET status = 'recovery', credential_version = credential_version + 1 WHERE id = ?", user.id);
      }
      await this.store.run("INSERT INTO auth_invitations (token_hash, user_id, reason, expires_at) VALUES (?, ?, ?, ?)", digest(token), user.id, recovery ? "recovery" : "invitation", expiresAt);
    });
    if (recovery) await this.notifyRevocation();
    return { token, url: `${this.origin}/enroll#${token}`, expiresAt };
  }

  private cookie(headers: Headers, name: string, token: string, expiresAt: number): void {
    const maxAge = Math.max(0, Math.ceil((expiresAt - this.now()) / 1000));
    headers.append("set-cookie", `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${this.secure ? "; Secure" : ""}`);
  }

  private clearCookie(headers: Headers, name: string): void {
    this.cookie(headers, name, "", 0);
  }

  private async clearPending(request: Request, headers: Headers): Promise<void> {
    return this.store.transaction(async () => {
      const token = cookieValue(request, this.pendingCookie);
      if (token) await this.store.run("DELETE FROM auth_pending WHERE token_hash = ?", digest(token));
      this.clearCookie(headers, this.pendingCookie);
    });
  }

  private async newPending(request: Request, headers: Headers, purpose: PendingPurpose, user: UserRow | null, data: PendingData): Promise<Pending> {
    return this.store.transaction(async () => {
      const previous = cookieValue(request, this.pendingCookie);
      if (previous) await this.store.run("DELETE FROM auth_pending WHERE token_hash = ?", digest(previous));
      const token = randomToken();
      const expiresAt = this.now() + (purpose === "enrollment" ? ENROLLMENT_LIFETIME : CHALLENGE_LIFETIME);
      await this.store.run("INSERT INTO auth_pending (token_hash, user_id, purpose, credential_version, data, expires_at) VALUES (?, ?, ?, ?, ?, ?)", digest(token), user?.id ?? null, purpose, user?.credential_version ?? null, JSON.stringify(data), expiresAt);
      this.cookie(headers, this.pendingCookie, token, expiresAt);
      return { token_hash: digest(token), user_id: user?.id ?? null, purpose, credential_version: user?.credential_version ?? null, data, expires_at: expiresAt };
    });
  }

  private async pending(request: Request, purpose?: PendingPurpose): Promise<Pending> {
    return this.store.transaction(async () => {
      const token = cookieValue(request, this.pendingCookie);
      const row = token ? await this.store.one<PendingRow>("SELECT * FROM auth_pending WHERE token_hash = ?", digest(token)) : undefined;
      if (!row || row.expires_at <= this.now() || (purpose && row.purpose !== purpose)) throw expiredFlow();
      if (row.user_id) {
        const user = await this.user(row.user_id);
        if (!user || user.credential_version !== row.credential_version) throw expiredFlow();
      }
      return { ...row, data: JSON.parse(row.data) as PendingData };
    });
  }

  private async updatePending(pending: Pending): Promise<void> {
    if (!(await this.store.run("UPDATE auth_pending SET data = ? WHERE token_hash = ? AND expires_at > ?", JSON.stringify(pending.data), pending.token_hash, this.now()))) throw expiredFlow();
  }

  private async requireCurrentPending(pending: Pending): Promise<void> {
    return this.store.transaction(async () => {
      const current = await this.store.one<PendingRow>("SELECT * FROM auth_pending WHERE token_hash = ? AND expires_at > ?", pending.token_hash, this.now());
      if (!current || current.data !== JSON.stringify(pending.data) || current.credential_version !== pending.credential_version || current.purpose !== pending.purpose) throw expiredFlow();
    });
  }

  private async enrollmentState(pending: Pending): Promise<EnrollmentState> {
    return this.store.transaction(async () => {
      const user = (await this.user(pending.user_id!))!;
      return { state: "enrollment", email: user.email, name: pending.data.name ?? user.name, reason: pending.data.reason! };
    });
  }

  private async sessionState(request: Request): Promise<AuthState> {
    return this.store.transaction(async () => {
      const principal = await this.authenticate(request);
      if (principal) return { state: "authenticated", user: publicUser((await this.user(principal.userId))!), expiresAt: principal.expiresAt };
      try {
        const pending = await this.pending(request);
        if (pending.purpose === "enrollment") return await this.enrollmentState(pending);
        if (pending.purpose === "password") return { state: "totp_required", email: (await this.user(pending.user_id!))!.email };
      } catch (error) {
        if (!(error instanceof AuthError)) throw error;
      }
      return { state: "signed_out" };
    });
  }

  private async requirePrincipal(request: Request, fresh = false): Promise<AuthPrincipal> {
    return this.store.transaction(async () => {
      const principal = await this.authenticate(request);
      if (!principal) throw new AuthError(401, "SIGN_IN_REQUIRED", "Sign in to continue.");
      if (fresh && (await this.session(principal.sessionId))!.session.created_at + FRESH_AUTH <= this.now()) {
        throw new AuthError(403, "REAUTHENTICATION_REQUIRED", "Sign out and sign in again before changing security settings.");
      }
      return principal;
    });
  }

  private async rateLimit(action: string, subject: string, maximum = 5): Promise<string> {
    const key = digest(`${action}:${subject}`);
    await this.store.transaction(async () => {
      const row = await this.store.one<{ starts_at: number; attempts: number }>("SELECT * FROM auth_rate_limits WHERE key = ?", key);
      if (!row || row.starts_at + 5 * MINUTE <= this.now()) {
        await this.store.run("INSERT INTO auth_rate_limits (key, starts_at, attempts) VALUES (?, ?, 1) ON CONFLICT(key) DO UPDATE SET starts_at = excluded.starts_at, attempts = 1", key, this.now());
      } else {
        if (row.attempts >= maximum) throw new AuthError(429, "TOO_MANY_ATTEMPTS", "Too many attempts. Try again in five minutes.");
        await this.store.run("UPDATE auth_rate_limits SET attempts = attempts + 1 WHERE key = ?", key);
      }
    });
    return key;
  }

  private async clearRateLimit(key: string): Promise<void> {
    await this.store.run("DELETE FROM auth_rate_limits WHERE key = ?", key);
  }

  private async createSession(user: UserRow, request: Request, headers: Headers): Promise<AuthenticatedState> {
    return this.store.transaction(async () => {
      const oldToken = cookieValue(request, this.sessionCookie);
      if (oldToken) await this.store.run("DELETE FROM auth_sessions WHERE token_hash = ?", digest(oldToken));
      const token = randomToken();
      const expiresAt = this.now() + SESSION_LIFETIME;
      await this.store.run("INSERT INTO auth_sessions (id, token_hash, user_id, credential_version, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)", randomBytes(16).toString("base64url"), digest(token), user.id, user.credential_version, this.now(), expiresAt, this.now());
      await this.clearPending(request, headers);
      this.cookie(headers, this.sessionCookie, token, expiresAt);
      return { state: "authenticated", user: publicUser(user), expiresAt };
    });
  }

  private async recoveryCodes(userId: string): Promise<string[]> {
    return this.store.transaction(async () => {
      const codes = newRecoveryCodes();
      await this.store.run("DELETE FROM auth_recovery_codes WHERE user_id = ?", userId);
      for (const code of codes) await this.store.run("INSERT INTO auth_recovery_codes (user_id, code_hash) VALUES (?, ?)", userId, digest(normalizeRecoveryCode(code)));
      return codes;
    });
  }

  private async securityState(principal: AuthPrincipal): Promise<SecurityState> {
    return this.store.transaction(async () => {
      const user = (await this.user(principal.userId))!;
      const session = (await this.session(principal.sessionId))!;
      return {
        passkeys: (await this.store.all<{ id: string; name: string; created_at: number }>("SELECT id, name, created_at FROM auth_passkeys WHERE user_id = ? ORDER BY created_at", user.id)).map((key) => ({ id: key.id, name: key.name, createdAt: key.created_at })),
        totpEnabled: !!user.totp_secret,
        passwordEnabled: !!user.password_hash,
        recoveryCodesRemaining: (await this.store.one<{ count: number }>("SELECT count(*) AS count FROM auth_recovery_codes WHERE user_id = ?", user.id))!.count,
        sessions: (await this.store.all<SessionRow>("SELECT * FROM auth_sessions WHERE user_id = ? AND expires_at > ? AND last_seen_at > ? ORDER BY created_at DESC", user.id, this.now(), this.now() - SESSION_IDLE)).map((row) => ({ id: row.id, createdAt: row.created_at, expiresAt: row.expires_at, current: row.id === principal.sessionId })),
        canManage: session.session.created_at + FRESH_AUTH > this.now(),
      };
    });
  }

  private async passwordLogin(body: Record<string, unknown>, request: Request, headers: Headers): Promise<AuthState> {
    const email = emailAddress(stringField(body, "email", 254));
    const password = stringField(body, "password", 128);
    const rate = await this.rateLimit("password", email, 8);
    const user = await this.findUser(email);
    const verified = await verifyPassword(password, user?.password_hash ?? null);
    if (!verified || !user || user.status !== "active" || !user.totp_secret) throw invalidAuthentication();
    return this.store.transaction(async () => {
      await this.currentUser(user, "active");
      await this.newPending(request, headers, "password", user, {});
      await this.clearRateLimit(rate);
      return { state: "totp_required", email: user.email };
    });
  }

  private async totpLogin(body: Record<string, unknown>, request: Request, headers: Headers): Promise<AuthenticatedState> {
    const pending = await this.pending(request, "password");
    const user = (await this.user(pending.user_id!))!;
    const rate = await this.rateLimit("totp", user.id);
    const step = user.totp_secret ? matchTotpStep(decryptSecret(user.totp_secret, this.key), stringField(body, "code", 6), this.now()) : null;
    if (step === null || user.status !== "active") throw invalidAuthentication();
    const result = await this.store.transaction(async () => {
      await this.requireCurrentPending(pending);
      if (!(await this.store.run("UPDATE auth_users SET totp_last_step = ? WHERE id = ? AND credential_version = ? AND totp_last_step < ? AND status = 'active'", step, user.id, pending.credential_version, step))) throw invalidAuthentication();
      return await this.createSession(user, request, headers);
    });
    await this.clearRateLimit(rate);
    await this.notifyRevocation();
    return result;
  }

  private async startEnrollment(body: Record<string, unknown>, request: Request, headers: Headers): Promise<EnrollmentState> {
    const token = stringField(body, "token", 128);
    const state = await this.store.transaction(async () => {
      const invitation = await this.store.one<{ user_id: string; reason: "invitation" | "recovery"; expires_at: number }>("SELECT * FROM auth_invitations WHERE token_hash = ?", digest(token));
      const user = invitation ? await this.user(invitation.user_id) : null;
      if (!invitation || !user || user.status === "active" || invitation.expires_at <= this.now()) throw new AuthError(401, "INVALID_INVITATION", "This enrollment link is invalid, expired, or already used. Request a new link from your operator.");
      await this.store.run("DELETE FROM auth_invitations WHERE token_hash = ?", digest(token));
      await this.store.run("DELETE FROM auth_pending WHERE user_id = ?", user.id);
      const currentSession = cookieValue(request, this.sessionCookie);
      if (currentSession) await this.store.run("DELETE FROM auth_sessions WHERE token_hash = ?", digest(currentSession));
      this.clearCookie(headers, this.sessionCookie);
      const pending = await this.newPending(request, headers, "enrollment", user, { reason: invitation.reason, name: user.name });
      return await this.enrollmentState(pending);
    });
    await this.notifyRevocation();
    return state;
  }

  private async startTotpEnrollment(body: Record<string, unknown>, request: Request, headers: Headers, security: boolean) {
    const principal = security ? await this.requirePrincipal(request, true) : null;
    const pending = security ? null : await this.pending(request, "enrollment");
    const user = (await this.user(principal?.userId ?? pending!.user_id!))!;
    const passwordHash = await hashPassword(newPassword(body));
    return this.store.transaction(async () => {
      await this.currentUser(user);
      if (security) await this.requirePrincipal(request, true);
      const current = security ? await this.newPending(request, headers, "security_totp", user, { sessionId: principal!.sessionId }) : await this.pending(request, "enrollment");
      const totp = newTotp(user.email, this.config.companyName ?? "Dispatch");
      current.data = {
        ...current.data,
        name: security ? user.name : displayName(stringField(body, "name", 100)),
        passwordHash,
        totpSecret: encryptSecret(totp.secret, this.key),
      };
      delete current.data.challenge;
      delete current.data.challengeExpiresAt;
      await this.updatePending(current);
      return totp;
    });
  }

  private async finishTotpEnrollment(body: Record<string, unknown>, request: Request, headers: Headers, security: boolean): Promise<AuthenticatedState> {
    const principal = security ? await this.requirePrincipal(request, true) : null;
    const pending = await this.pending(request, security ? "security_totp" : "enrollment");
    if (security && pending.data.sessionId !== principal!.sessionId) throw expiredFlow();
    if (!pending.data.totpSecret || !pending.data.passwordHash || !pending.data.name) throw expiredFlow();
    const user = (await this.user(pending.user_id!))!;
    const rate = await this.rateLimit("totp-enrollment", user.id);
    const step = matchTotpStep(decryptSecret(pending.data.totpSecret, this.key), stringField(body, "code", 6), this.now());
    if (step === null) throw invalidAuthentication();
    const result = await this.store.transaction(async () => {
      await this.requireCurrentPending(pending);
      if (security) await this.requirePrincipal(request, true);
      await this.currentUser(user);
      if (pending.data.reason === "recovery") await this.store.run("DELETE FROM auth_passkeys WHERE user_id = ?", user.id);
      await this.store.run("UPDATE auth_users SET name = ?, status = 'active', password_hash = ?, totp_secret = ?, totp_last_step = ?, credential_version = credential_version + 1 WHERE id = ?", pending.data.name!, pending.data.passwordHash!, pending.data.totpSecret!, step, user.id);
      await this.store.run("DELETE FROM auth_sessions WHERE user_id = ?", user.id);
      await this.store.run("DELETE FROM auth_pending WHERE user_id = ?", user.id);
      const recoveryCodes = await this.recoveryCodes(user.id);
      return { ...(await this.createSession((await this.user(user.id))!, request, headers)), recoveryCodes };
    });
    await this.clearRateLimit(rate);
    await this.notifyRevocation();
    return result;
  }

  private async registrationOptions(body: Record<string, unknown>, request: Request, headers: Headers, security: boolean) {
    const principal = security ? await this.requirePrincipal(request, true) : null;
    const pending = security ? null : await this.pending(request, "enrollment");
    const user = (await this.user(principal?.userId ?? pending!.user_id!))!;
    const name = displayName(stringField(body, "name", 100));
    const passkeyName = !security && body.passkeyName !== undefined ? displayName(stringField(body, "passkeyName", 100)) : undefined;
    const credentials = await this.store.all<PasskeyRow>("SELECT * FROM auth_passkeys WHERE user_id = ?", user.id);
    const options = await generateRegistrationOptions({
      rpName: this.config.companyName ?? "Dispatch",
      rpID: this.config.rpId,
      userID: new Uint8Array(Buffer.from(user.id, "utf8")),
      userName: user.email,
      userDisplayName: security ? user.name : name,
      attestationType: "none",
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      excludeCredentials: credentials.map((credential) => ({ id: credential.id, transports: JSON.parse(credential.transports) as AuthenticatorTransport[] })),
    });
    return this.store.transaction(async () => {
      await this.currentUser(user);
      if (security) await this.requirePrincipal(request, true);
      const current = security ? await this.newPending(request, headers, "security_passkey", user, { sessionId: principal!.sessionId, name }) : await this.pending(request, "enrollment");
      current.data = { ...current.data, name, passkeyName, challenge: options.challenge, challengeExpiresAt: this.now() + CHALLENGE_LIFETIME };
      // Choosing a passkey during enrollment discards the unfinished TOTP secret.
      delete current.data.totpSecret;
      delete current.data.passwordHash;
      await this.updatePending(current);
      return { options };
    });
  }

  private async takeChallenge(pending: Pending): Promise<string> {
    if (!pending.data.challenge || !pending.data.challengeExpiresAt || pending.data.challengeExpiresAt <= this.now()) throw expiredFlow();
    const previous = JSON.stringify(pending.data);
    const challenge = pending.data.challenge;
    delete pending.data.challenge;
    delete pending.data.challengeExpiresAt;
    if (!(await this.store.run("UPDATE auth_pending SET data = ? WHERE token_hash = ? AND data = ? AND expires_at > ?", JSON.stringify(pending.data), pending.token_hash, previous, this.now()))) throw expiredFlow();
    return challenge;
  }

  private async verifyRegistration(body: Record<string, unknown>, pending: Pending): Promise<Extract<VerifiedRegistrationResponse, { verified: true }>> {
    const challenge = await this.takeChallenge(pending);
    try {
      const result = await verifyRegistrationResponse({
        response: body.response as RegistrationResponseJSON,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.config.rpId,
        requireUserPresence: true,
        requireUserVerification: true,
      });
      if (!result.verified || !result.registrationInfo.userVerified) throw invalidAuthentication();
      return result;
    } catch {
      throw invalidAuthentication();
    }
  }

  private async finishPasskeyEnrollment(body: Record<string, unknown>, request: Request, headers: Headers, security: boolean): Promise<AuthenticatedState | SecurityState> {
    const principal = security ? await this.requirePrincipal(request, true) : null;
    const pending = await this.pending(request, security ? "security_passkey" : "enrollment");
    if (security && pending.data.sessionId !== principal!.sessionId) throw expiredFlow();
    const user = (await this.user(pending.user_id!))!;
    const rate = await this.rateLimit("passkey-enrollment", user.id);
    const verification = await this.verifyRegistration(body, pending);
    if (security) await this.requirePrincipal(request, true);
    const result = await this.store.transaction(async () => {
      await this.requireCurrentPending(pending);
      if (security) await this.requirePrincipal(request, true);
      await this.currentUser(user);
      const info = verification.registrationInfo;
      if (await this.store.one("SELECT id FROM auth_passkeys WHERE id = ?", info.credential.id)) throw new AuthError(409, "PASSKEY_EXISTS", "That passkey is already registered.");
      if (!security) {
        if (pending.data.reason === "recovery") await this.store.run("DELETE FROM auth_passkeys WHERE user_id = ?", user.id);
        await this.store.run("DELETE FROM auth_recovery_codes WHERE user_id = ?", user.id);
        await this.store.run("UPDATE auth_users SET name = ?, status = 'active', password_hash = NULL, totp_secret = NULL, totp_last_step = -1, credential_version = credential_version + 1 WHERE id = ?", pending.data.name!, user.id);
        await this.store.run("DELETE FROM auth_sessions WHERE user_id = ?", user.id);
      }
      await this.store.run("INSERT INTO auth_passkeys (id, user_id, name, public_key, counter, transports, device_type, backed_up, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", info.credential.id, user.id, security ? pending.data.name! : pending.data.passkeyName ?? "Passkey", Buffer.from(info.credential.publicKey).toString("base64url"), info.credential.counter, JSON.stringify(info.credential.transports ?? []), info.credentialDeviceType, info.credentialBackedUp ? 1 : 0, this.now());
      if (security) {
        await this.clearPending(request, headers);
        return await this.securityState(principal!);
      }
      return await this.createSession((await this.user(user.id))!, request, headers);
    });
    await this.clearRateLimit(rate);
    if (!security) await this.notifyRevocation();
    return result;
  }

  private async passkeyLoginOptions(request: Request, headers: Headers) {
    const options = await generateAuthenticationOptions({ rpID: this.config.rpId, userVerification: "required" });
    await this.newPending(request, headers, "passkey_login", null, { challenge: options.challenge, challengeExpiresAt: this.now() + CHALLENGE_LIFETIME });
    return { options };
  }

  private async passkeyLogin(body: Record<string, unknown>, request: Request, headers: Headers): Promise<AuthenticatedState> {
    const pending = await this.pending(request, "passkey_login");
    const challenge = await this.takeChallenge(pending);
    const response = body.response as AuthenticationResponseJSON | undefined;
    const credential = typeof response?.id === "string" ? await this.store.one<PasskeyRow>("SELECT * FROM auth_passkeys WHERE id = ?", response.id) : undefined;
    const user = credential ? await this.user(credential.user_id) : undefined;
    if (!credential || !user || user.status !== "active") throw invalidAuthentication();
    const rate = await this.rateLimit("passkey", user.id);
    let verification;
    try {
      if (response?.response.userHandle !== Buffer.from(user.id).toString("base64url")) throw invalidAuthentication();
      verification = await verifyAuthenticationResponse({
        response: response!,
        expectedChallenge: challenge,
        expectedOrigin: this.origin,
        expectedRPID: this.config.rpId,
        requireUserVerification: true,
        credential: { id: credential.id, publicKey: new Uint8Array(Buffer.from(credential.public_key, "base64url")), counter: credential.counter, transports: JSON.parse(credential.transports) as AuthenticatorTransport[] },
      });
      if (!verification.verified || !verification.authenticationInfo.userVerified) throw invalidAuthentication();
    } catch {
      throw invalidAuthentication();
    }
    const result = await this.store.transaction(async () => {
      await this.requireCurrentPending(pending);
      await this.currentUser(user, "active");
      if (!(await this.store.run("UPDATE auth_passkeys SET counter = ?, device_type = ?, backed_up = ? WHERE id = ? AND counter = ?", verification.authenticationInfo.newCounter, verification.authenticationInfo.credentialDeviceType, verification.authenticationInfo.credentialBackedUp ? 1 : 0, credential.id, credential.counter))) throw invalidAuthentication();
      return await this.createSession(user, request, headers);
    });
    await this.clearRateLimit(rate);
    await this.notifyRevocation();
    return result;
  }

  private async startRecovery(body: Record<string, unknown>, request: Request, headers: Headers): Promise<EnrollmentState> {
    const email = emailAddress(stringField(body, "email", 254));
    const rate = await this.rateLimit("recovery", email);
    const user = await this.findUser(email);
    const verified = await verifyPassword(stringField(body, "password", 128), user?.password_hash ?? null);
    const codeHash = digest(normalizeRecoveryCode(stringField(body, "code", 128)));
    if (!verified || !user || !["active", "recovery"].includes(user.status)) throw invalidAuthentication();
    const state = await this.store.transaction(async () => {
      await this.currentUser(user);
      if (!(await this.store.run("DELETE FROM auth_recovery_codes WHERE user_id = ? AND code_hash = ?", user.id, codeHash))) throw invalidAuthentication();
      await this.store.run("UPDATE auth_users SET status = 'recovery', credential_version = credential_version + 1 WHERE id = ?", user.id);
      await this.store.run("DELETE FROM auth_sessions WHERE user_id = ?", user.id);
      await this.store.run("DELETE FROM auth_pending WHERE user_id = ?", user.id);
      await this.store.run("DELETE FROM auth_invitations WHERE user_id = ?", user.id);
      const currentSession = cookieValue(request, this.sessionCookie);
      if (currentSession) await this.store.run("DELETE FROM auth_sessions WHERE token_hash = ?", digest(currentSession));
      this.clearCookie(headers, this.sessionCookie);
      const pending = await this.newPending(request, headers, "enrollment", (await this.user(user.id))!, { reason: "recovery", name: user.name });
      return await this.enrollmentState(pending);
    });
    await this.clearRateLimit(rate);
    await this.notifyRevocation();
    return state;
  }

  private async removePasskey(body: Record<string, unknown>, request: Request): Promise<SecurityState> {
    const principal = await this.requirePrincipal(request, true);
    const id = stringField(body, "id");
    await this.store.transaction(async () => {
      await this.requirePrincipal(request, true);
      const credential = await this.store.one<PasskeyRow>("SELECT * FROM auth_passkeys WHERE id = ? AND user_id = ?", id, principal.userId);
      if (!credential) throw new AuthError(404, "PASSKEY_NOT_FOUND", "That passkey was not found.");
      const user = (await this.user(principal.userId))!;
      const count = (await this.store.one<{ count: number }>("SELECT count(*) AS count FROM auth_passkeys WHERE user_id = ?", principal.userId))!.count;
      if (count === 1 && !(user.password_hash && user.totp_secret)) throw new AuthError(409, "LAST_AUTHENTICATOR", "Add another passkey or password and TOTP before removing your last sign-in method.");
      await this.store.run("DELETE FROM auth_passkeys WHERE id = ?", id);
      await this.store.run("DELETE FROM auth_sessions WHERE user_id = ? AND id != ?", principal.userId, principal.sessionId);
    });
    await this.notifyRevocation();
    return await this.securityState(principal);
  }

  private async revokeUserSession(body: Record<string, unknown>, request: Request, headers: Headers) {
    const result = await this.store.transaction(async () => {
      const principal = await this.requirePrincipal(request);
      const id = stringField(body, "id");
      await this.store.run("DELETE FROM auth_sessions WHERE id = ? AND user_id = ?", id, principal.userId);
      if (id === principal.sessionId) {
        this.clearCookie(headers, this.sessionCookie);
        await this.clearPending(request, headers);
        return { state: "signed_out" };
      }
      return this.securityState(principal);
    });
    await this.notifyRevocation();
    return result;
  }

  async handle(request: Request): Promise<Response | null> {
    return this.admit(async () => {
      const path = new URL(request.url).pathname;
      if (!path.startsWith("/api/auth/")) return null;
      const headers = new Headers({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
      try {
        if (this.lastCleanup + 5 * MINUTE <= this.now()) {
          await this.removeExpiredState();
          this.lastCleanup = this.now();
        }
        if (request.method === "GET") {
          if (path === "/api/auth/session") return new Response(JSON.stringify((await this.sessionState(request))), { headers });
          if (path === "/api/auth/security") return new Response(JSON.stringify((await this.securityState((await this.requirePrincipal(request))))), { headers });
          throw new AuthError(404, "NOT_FOUND", "The authentication endpoint was not found.");
        }
        if (request.method !== "POST") throw new AuthError(405, "METHOD_NOT_ALLOWED", "Use the documented method for this authentication endpoint.");
        if (request.headers.get("origin") !== this.origin) throw new AuthError(403, "ORIGIN_MISMATCH", "The request did not come from this application.");
        const body = await jsonBody(request);
        let result: unknown;
        switch (path) {
          case "/api/auth/password": result = await this.passwordLogin(body, request, headers); break;
          case "/api/auth/totp": result = (await this.totpLogin(body, request, headers)); break;
          case "/api/auth/passkey/login/options": result = await this.passkeyLoginOptions(request, headers); break;
          case "/api/auth/passkey/login/verify": result = await this.passkeyLogin(body, request, headers); break;
          case "/api/auth/enrollment/start": result = (await this.startEnrollment(body, request, headers)); break;
          case "/api/auth/enrollment/totp/start": result = await this.startTotpEnrollment(body, request, headers, false); break;
          case "/api/auth/enrollment/totp/verify": result = (await this.finishTotpEnrollment(body, request, headers, false)); break;
          case "/api/auth/enrollment/passkey/options": result = await this.registrationOptions(body, request, headers, false); break;
          case "/api/auth/enrollment/passkey/verify": result = await this.finishPasskeyEnrollment(body, request, headers, false); break;
          case "/api/auth/recovery/start": result = await this.startRecovery(body, request, headers); break;
          case "/api/auth/security/passkey/options": result = await this.registrationOptions(body, request, headers, true); break;
          case "/api/auth/security/passkey/verify": result = await this.finishPasskeyEnrollment(body, request, headers, true); break;
          case "/api/auth/security/passkey/remove": result = (await this.removePasskey(body, request)); break;
          case "/api/auth/security/totp/start": result = await this.startTotpEnrollment(body, request, headers, true); break;
          case "/api/auth/security/totp/verify": result = (await this.finishTotpEnrollment(body, request, headers, true)); break;
          case "/api/auth/security/sessions/revoke": result = (await this.revokeUserSession(body, request, headers)); break;
          case "/api/auth/logout": {
            await this.store.transaction(async () => {
              const token = cookieValue(request, this.sessionCookie);
              if (token) await this.store.run("DELETE FROM auth_sessions WHERE token_hash = ?", digest(token));
              this.clearCookie(headers, this.sessionCookie);
              await this.clearPending(request, headers);
            });
            await this.notifyRevocation();
            result = { state: "signed_out" };
            break;
          }
          default: throw new AuthError(404, "NOT_FOUND", "The authentication endpoint was not found.");
        }
        return new Response(JSON.stringify(result), { headers });
      } catch (error) {
        headers.delete("set-cookie");
        const known = error instanceof AuthError;
        if (!known) console.error("Authentication request failed:", error instanceof Error ? error.message : "Unknown error");
        const status = known ? error.status : 500;
        const message = known ? error.message : "Authentication could not be completed. Try again or contact your operator.";
        return new Response(JSON.stringify({ error: { code: known ? error.code : "INTERNAL_ERROR", message } }), { status, headers });
      }
    });
  }
}
