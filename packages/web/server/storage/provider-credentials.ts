import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { Client, type ClientConfig, type QueryResultRow } from "pg";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { z } from "zod";

export const credentialSchema = z.union([
  z.object({ type: z.literal("api_key"), key: z.string().optional(), env: z.record(z.string(), z.string()).optional() }),
  z.object({ type: z.literal("oauth"), access: z.string(), refresh: z.string(), expires: z.number() }).passthrough(),
]);
const envelopeSchema = z.object({ version: z.literal(1), key: z.array(z.string()).length(3), value: z.array(z.string()).length(3) }).strict();
type CredentialRow = { provider: string; credential: string | null; pending: boolean };

export type PostgresCredentialStoreOptions = {
  /** Trusted operator configuration, including verified TLS when remote. No worker credentials. */
  database: ClientConfig;
  installationId: string;
  /** Externally managed key; never generated or persisted by this adapter. */
  encryptionKey: Buffer;
  /** Explicit operator assertion that this recorded previous owner has been retired. */
  recoverOwnerId?: string;
};

/**
 * Backend-only Pi 1.0.4 CredentialStore. One installation owner and one ordered
 * connection, like the native file store's lock. Never reconnect/retry implicitly.
 * The owner must be retired before replacement: a released DB lock cannot fence
 * an OAuth request already accepted by a provider.
 */
export class PostgresCredentialStore implements CredentialStore {
  readonly ownerId = randomUUID();
  private tail: Promise<void> = Promise.resolve();
  private accepting = true;
  private admissionGeneration = 0;
  private failure?: Error;
  private closing?: Promise<void>;
  private draining?: Promise<void>;
  private readonly key: Buffer;

  private constructor(private readonly client: Client, private readonly installation: string, key: Buffer) {
    this.key = Buffer.from(key);
    client.on("error", () => { this.failure ??= new Error("Provider credential database connection lost; retire owner before reopening."); });
    client.on("end", () => { this.failure ??= new Error("Provider credential database connection ended."); });
  }

  static async open(options: PostgresCredentialStoreOptions): Promise<PostgresCredentialStore> {
    if (!options.installationId || options.installationId.length > 200 || options.encryptionKey.length !== 32)
      throw new Error("Provider credentials require an installation identity and a 32-byte external key.");
    const client = new Client({ connectionTimeoutMillis: 60_000, ...options.database, application_name: "dispatch-provider-credentials" });
    const store = new PostgresCredentialStore(client, options.installationId, options.encryptionKey);
    try {
      await client.connect();
      const lock = await store.query<{ held: boolean }>("SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS held", [`dispatch-provider-credentials:${options.installationId}`]);
      if (!lock.rows[0]?.held) throw new Error("Provider credential owner already exists.");
      // Serialize schema initialization even across installations sharing this DB.
      await store.query("BEGIN");
      await store.query("SELECT pg_advisory_xact_lock(hashtextextended('dispatch-provider-credentials-schema', 0))");
      await store.query(`CREATE SCHEMA IF NOT EXISTS dispatch_provider_auth;
        REVOKE ALL ON SCHEMA dispatch_provider_auth FROM PUBLIC;
        CREATE TABLE IF NOT EXISTS dispatch_provider_auth.installations (
          installation TEXT PRIMARY KEY, verification TEXT NOT NULL, owner_id TEXT
        );
        CREATE TABLE IF NOT EXISTS dispatch_provider_auth.credentials (
          installation TEXT NOT NULL REFERENCES dispatch_provider_auth.installations(installation),
          provider TEXT NOT NULL, credential TEXT, pending BOOLEAN NOT NULL DEFAULT FALSE,
          PRIMARY KEY (installation, provider)
        )`);
      const identity = await store.query<{ verification: string; owner_id: string | null }>("SELECT verification, owner_id FROM dispatch_provider_auth.installations WHERE installation=$1 FOR UPDATE", [store.installation]);
      if (identity.rows[0]) {
        if (store.decrypt(identity.rows[0].verification, "installation") !== "dispatch-provider-credentials:v1")
          throw new Error("Provider credential identity mismatch.");
        const previousOwner = identity.rows[0].owner_id;
        if (previousOwner && options.recoverOwnerId !== previousOwner)
          throw new Error("Previous provider credential owner requires confirmed retirement.");
        if (options.recoverOwnerId && options.recoverOwnerId !== previousOwner)
          throw new Error("Provider credential recovery owner does not match.");
      } else {
        if (options.recoverOwnerId) throw new Error("Cannot recover an unknown credential installation.");
        await store.query("INSERT INTO dispatch_provider_auth.installations (installation, verification) VALUES ($1, $2)", [store.installation, store.encrypt("dispatch-provider-credentials:v1", "installation")]);
      }
      await store.query("UPDATE dispatch_provider_auth.installations SET owner_id=$2 WHERE installation=$1", [store.installation, store.ownerId]);
      await store.query("COMMIT");
      return store;
    } catch {
      // Connection strings, SQL and provider response bodies must not reach logs.
      await client.end().catch(() => {});
      store.key.fill(0);
      throw new Error("Cannot open provider credential store: check database ownership, installation identity and external key.");
    }
  }

  get healthy() { return !this.closing && !this.failure; }
  get admitting() { return this.accepting && this.healthy; }

  private assertHealthy() { if (this.failure) throw this.failure; }

  private async query<T extends QueryResultRow = QueryResultRow>(text: string, values?: unknown[]) {
    this.assertHealthy();
    try {
      const result = await this.client.query<T>(text, values);
      this.assertHealthy();
      return result;
    } catch {
      this.failure ??= new Error("Provider credential database operation failed; outcome may be uncertain. Retire owner before reopening.");
      throw this.failure;
    }
  }

  private enqueue<T>(operation: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    if (!this.accepting) return Promise.reject(new Error("Provider credential store is quiesced."));
    const result = this.tail.then(async () => {
      this.assertHealthy();
      // Cancellation affects waiting, not persistence after the callback starts.
      options?.signal?.throwIfAborted();
      return operation();
    });
    this.tail = result.then(() => {}, () => {});
    return result;
  }

  private async row(provider: string): Promise<CredentialRow | undefined> {
    if (!provider) throw new Error("Provider identity is required.");
    const result = await this.query<CredentialRow>("SELECT provider, credential, pending FROM dispatch_provider_auth.credentials WHERE installation=$1 AND provider=$2", [this.installation, provider]);
    return result.rows[0];
  }

  private decode(row: CredentialRow | undefined): Credential | undefined {
    if (row?.pending) throw new Error("Provider credential update was interrupted or unconfirmed; explicitly log out and authorize again.");
    if (!row?.credential) return undefined;
    try { return credentialSchema.parse(JSON.parse(this.decrypt(row.credential, `provider:${row.provider}`))) as Credential; }
    catch { throw new Error("Cannot decrypt or validate provider credentials; restore the matching external key and database."); }
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(async () => this.decode(await this.row(providerId)), options);
  }

  /** Side-effect-free interrupted-update metadata for Settings; never resolves auth. */
  inspect(providerId: string, options?: AuthOperationOptions): Promise<{ pending: boolean }> {
    return this.enqueue(async () => ({ pending: !!(await this.row(providerId))?.pending }), options);
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.enqueue(async () => {
      const rows = await this.query<CredentialRow>("SELECT provider, credential, pending FROM dispatch_provider_auth.credentials WHERE installation=$1 ORDER BY provider", [this.installation]);
      // Keep interrupted credentials visible in settings, but never usable by read().
      return rows.rows.flatMap(row => {
        const credential = this.decode({ ...row, pending: false });
        return credential ? [{ providerId: row.provider, type: credential.type }] : [];
      });
    }, options);
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const current = this.decode(await this.row(providerId));
      options?.signal?.throwIfAborted();
      // Autocommit intent BEFORE provider effects. A transaction rolled back by a
      // crash would lose this marker and silently reuse a rotated refresh token.
      await this.query(`INSERT INTO dispatch_provider_auth.credentials (installation, provider, pending)
        VALUES ($1, $2, TRUE) ON CONFLICT (installation, provider) DO UPDATE SET pending=TRUE`, [this.installation, providerId]);
      // Cancellation may arrive during the intent write. Before fn has run,
      // clearing this marker is safe; failed cleanup still poisons the store.
      if (options?.signal?.aborted) {
        await this.query("UPDATE dispatch_provider_auth.credentials SET pending=FALSE WHERE installation=$1 AND provider=$2", [this.installation, providerId]);
        options.signal.throwIfAborted();
      }
      // Do not retry fn or clear intent on rejection: external effects may exist.
      const next = await fn(current);
      this.assertHealthy();
      const credential = next === undefined ? current : credentialSchema.parse(next) as Credential;
      const encrypted = credential === undefined ? null : this.encrypt(JSON.stringify(credential), `provider:${providerId}`);
      await this.query("UPDATE dispatch_provider_auth.credentials SET credential=$3, pending=FALSE WHERE installation=$1 AND provider=$2", [this.installation, providerId, encrypted]);
      return credential;
    }, options);
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(async () => {
      if (!providerId) throw new Error("Provider identity is required.");
      // Explicit logout is also the recovery path for an interrupted mutation.
      await this.query("DELETE FROM dispatch_provider_auth.credentials WHERE installation=$1 AND provider=$2", [this.installation, providerId]);
    }, options);
  }

  /** Seal admission and await underlying writes, including cancelled HTTP callers. */
  quiesce(): Promise<void> {
    this.admissionGeneration++;
    this.accepting = false;
    this.draining ??= this.tail.then(() => { this.assertHealthy(); });
    return this.draining;
  }

  /** Only the application's authenticated undrain may reopen admission. */
  async resume(): Promise<void> {
    if (this.closing) throw new Error("Provider credential store is closing.");
    const generation = ++this.admissionGeneration;
    await this.draining;
    this.assertHealthy();
    if (this.closing) throw new Error("Provider credential store is closing.");
    if (generation === this.admissionGeneration) {
      this.draining = undefined;
      this.accepting = true;
    }
  }

  close(): Promise<void> {
    this.accepting = false;
    this.closing ??= this.tail.then(async () => {
      try {
        // Clear the latch only after every admitted callback and write settled.
        // On connection failure retain it for explicit operator reconciliation.
        if (!this.failure) await this.query("UPDATE dispatch_provider_auth.installations SET owner_id=NULL WHERE installation=$1 AND owner_id=$2", [this.installation, this.ownerId]);
      } finally {
        try { await this.client.end(); } finally { this.key.fill(0); }
      }
    });
    return this.closing;
  }

  private context(purpose: string) { return Buffer.from(JSON.stringify(["dispatch-provider-auth:v1", this.installation, purpose])); }

  private encrypt(value: string, purpose: string): string {
    const dataKey = randomBytes(32);
    const seal = (plaintext: Buffer, key: Buffer, suffix: string) => {
      const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
      cipher.setAAD(this.context(`${purpose}:${suffix}`));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")];
    };
    try { return JSON.stringify({ version: 1, key: seal(dataKey, this.key, "key"), value: seal(Buffer.from(value), dataKey, "value") }); }
    finally { dataKey.fill(0); }
  }

  private decrypt(value: string, purpose: string): string {
    const envelope = envelopeSchema.parse(JSON.parse(value));
    const unseal = (parts: string[], key: Buffer, suffix: string) => {
      const [iv, tag, ciphertext] = parts.map(part => Buffer.from(part, "base64url"));
      if (iv!.length !== 12 || tag!.length !== 16) throw new Error("Invalid encrypted provider credential.");
      const cipher = createDecipheriv("aes-256-gcm", key, iv!);
      cipher.setAAD(this.context(`${purpose}:${suffix}`));
      cipher.setAuthTag(tag!);
      return Buffer.concat([cipher.update(ciphertext!), cipher.final()]);
    };
    const dataKey = unseal(envelope.key, this.key, "key");
    try { return unseal(envelope.value, dataKey, "value").toString("utf8"); }
    finally { dataKey.fill(0); }
  }
}
