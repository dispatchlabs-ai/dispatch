import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export class AuthStore {
  readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.database.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS auth_users (
        id TEXT PRIMARY KEY,
        company_id TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('invited', 'active', 'recovery')),
        password_hash TEXT,
        totp_secret TEXT,
        totp_last_step INTEGER NOT NULL DEFAULT -1,
        credential_version INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS auth_passkeys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        public_key TEXT NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        device_type TEXT NOT NULL,
        backed_up INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT NOT NULL UNIQUE,
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        credential_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_user ON auth_sessions(user_id);
      CREATE TABLE IF NOT EXISTS auth_invitations (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        reason TEXT NOT NULL CHECK (reason IN ('invitation', 'recovery')),
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_pending (
        token_hash TEXT PRIMARY KEY,
        user_id TEXT REFERENCES auth_users(id) ON DELETE CASCADE,
        purpose TEXT NOT NULL,
        credential_version INTEGER,
        data TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS auth_recovery_codes (
        code_hash TEXT NOT NULL,
        user_id TEXT NOT NULL REFERENCES auth_users(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, code_hash)
      );
      CREATE TABLE IF NOT EXISTS auth_rate_limits (
        key TEXT PRIMARY KEY,
        starts_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL
      );
    `);
  }

  one<T>(sql: string, ...parameters: SQLInputValue[]): T | undefined {
    return this.database.prepare(sql).get(...parameters) as T | undefined;
  }

  all<T>(sql: string, ...parameters: SQLInputValue[]): T[] {
    return this.database.prepare(sql).all(...parameters) as T[];
  }

  run(sql: string, ...parameters: SQLInputValue[]): number {
    return Number(this.database.prepare(sql).run(...parameters).changes);
  }

  transaction<T>(operation: () => T): T {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.database.exec("COMMIT");
      return result;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.database.close();
  }
}
