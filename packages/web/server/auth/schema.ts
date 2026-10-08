// Shared auth schema; PostgreSQL widens INTEGER for millisecond timestamps.
export const AUTH_SCHEMA = `
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
`;
