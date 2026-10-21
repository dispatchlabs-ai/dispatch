import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";
import { decryptSecret, encryptSecret, loadSecretKey } from "../auth/crypto.js";
import { credentialSchema } from "./provider-credentials.js";

type CredentialRow = { provider: string; credential: string | null; pending: number };

/** Local, single-owner counterpart of PostgresCredentialStore. No auth.json import. */
export class LocalCredentialStore implements CredentialStore {
  private tail: Promise<void> = Promise.resolve();
  private failure?: Error;
  private closing?: Promise<void>;

  private constructor(private readonly db: DatabaseSync, private readonly key: Buffer, readonly installationId: string) {}

  static open(options: { databasePath: string; keyPath: string }): LocalCredentialStore {
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(options.databasePath);
    let key: Buffer | undefined;
    try {
      chmodSync(options.databasePath, 0o600);
      // Keep the exclusive file lock across commits. Unlike an uncommitted owner
      // transaction, each pending marker below must survive process death.
      db.exec("PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; BEGIN EXCLUSIVE;");
      db.exec(`CREATE TABLE IF NOT EXISTS installation (id TEXT PRIMARY KEY, verification TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS credentials (provider TEXT PRIMARY KEY, credential TEXT, pending INTEGER NOT NULL DEFAULT 0);`);
      const existing = db.prepare("SELECT id, verification FROM installation").get() as { id: string; verification: string } | undefined;
      key = loadSecretKey(options.keyPath, !!existing || !!db.prepare("SELECT 1 FROM credentials LIMIT 1").get());
      const installationId = existing?.id ?? randomUUID();
      const verification = `dispatch-provider-credentials:v1:${installationId}`;
      if (existing) {
        if (decryptSecret(existing.verification, key) !== verification) throw new Error("Credential installation mismatch.");
      } else {
        db.prepare("INSERT INTO installation VALUES (?, ?)").run(installationId, encryptSecret(verification, key));
      }
      db.exec("COMMIT");
      return new LocalCredentialStore(db, key, installationId);
    } catch {
      db.close();
      key?.fill(0);
      throw new Error("Cannot open local provider credentials; check exclusive ownership and the matching encryption key.");
    }
  }

  private enqueue<T>(action: () => Promise<T>, options?: AuthOperationOptions): Promise<T> {
    if (this.closing) return Promise.reject(new Error("Provider credential store is closing."));
    const operation = this.tail.then(() => {
      if (this.failure) throw this.failure;
      options?.signal?.throwIfAborted();
      return action();
    });
    this.tail = operation.then(() => {}, () => {});
    return operation;
  }

  private write(sql: string, ...parameters: SQLInputValue[]) {
    try { this.db.prepare(sql).run(...parameters); }
    catch {
      this.failure ??= new Error("Provider credential write failed; outcome may be uncertain. Close the owner before recovery.");
      throw this.failure;
    }
  }

  private row(provider: string): CredentialRow | undefined {
    if (!provider) throw new Error("Provider identity is required.");
    return this.db.prepare("SELECT provider, credential, pending FROM credentials WHERE provider=?").get(provider) as CredentialRow | undefined;
  }

  private decode(row: CredentialRow | undefined): Credential | undefined {
    if (row?.pending) throw new Error("Provider credential update was interrupted or unconfirmed; disconnect and authorize again.");
    if (!row?.credential) return undefined;
    try {
      const saved = JSON.parse(decryptSecret(row.credential, this.key)) as { installation: string; provider: string; credential: unknown };
      if (saved.installation !== this.installationId || saved.provider !== row.provider) throw new Error("Credential binding mismatch.");
      return credentialSchema.parse(saved.credential) as Credential;
    } catch { throw new Error("Cannot decrypt or validate provider credentials; restore the matching key and database."); }
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(async () => this.decode(this.row(providerId)), options);
  }

  /** Pending intent is metadata, not proof of usable credentials. Never refresh here. */
  inspect(providerId: string, options?: AuthOperationOptions): Promise<{ pending: boolean }> {
    return this.enqueue(async () => ({ pending: !!this.row(providerId)?.pending }), options);
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.enqueue(async () => {
      const rows = this.db.prepare("SELECT provider, credential, pending FROM credentials ORDER BY provider").all() as CredentialRow[];
      return rows.flatMap(row => {
        const credential = this.decode({ ...row, pending: 0 });
        return credential ? [{ providerId: row.provider, type: credential.type }] : [];
      });
    }, options);
  }

  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      const current = this.decode(this.row(providerId));
      options?.signal?.throwIfAborted();
      this.write(`INSERT INTO credentials (provider, pending) VALUES (?, 1)
        ON CONFLICT(provider) DO UPDATE SET pending=1`, providerId);
      // The marker is already committed before any token exchange. On rejection
      // leave it intact: the provider may have consumed a rotating refresh token.
      const next = await fn(current);
      const credential = next === undefined ? current : credentialSchema.parse(next) as Credential;
      const encrypted = credential === undefined ? null : encryptSecret(JSON.stringify({ installation: this.installationId, provider: providerId, credential }), this.key);
      // Once admitted, cancellation never drops the returned token before save.
      this.write("UPDATE credentials SET credential=?, pending=0 WHERE provider=?", encrypted, providerId);
      return credential;
    }, options);
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(async () => {
      if (!providerId) throw new Error("Provider identity is required.");
      this.write("DELETE FROM credentials WHERE provider=?", providerId);
    }, options);
  }

  close(): Promise<void> {
    this.closing ??= this.tail.then(() => {
      try { this.db.close(); } finally { this.key.fill(0); }
    });
    return this.closing;
  }
}
