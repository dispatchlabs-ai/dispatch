import { resolve } from "node:path";
import { z } from "zod";
import type { PiStorageConfig } from "./storage/open.js";

const environmentSchema = z.object({
  DISPATCH_ORIGIN: z.url().default("http://localhost:3001"),
  DISPATCH_HOST: z.string().min(1).default("127.0.0.1"),
  DISPATCH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DISPATCH_DATA_DIR: z.string().min(1).default(".local/state/dispatch"),
  DISPATCH_PI_STORAGE: z.enum(["sqlite", "postgres"]).default("sqlite"),
  DISPATCH_POSTGRES_URL: z.string().min(1).optional(),
  DISPATCH_POSTGRES_STORE_ID: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/).optional(),
  DISPATCH_WORKSPACE_DIR: z.string().min(1).default("."),
  DISPATCH_READ_ALL_PROJECT_USER_IDS: z.string().default(""),
  DISPATCH_GITHUB_CONFIG_FILE: z.string().startsWith("/").optional(),
  DISPATCH_AGENT_CONNECTIONS_FILE: z.string().min(1).optional(),
  DISPATCH_COMPANY_ID: z.string().min(1).max(100).default("dispatch"),
  DISPATCH_COMPANY_NAME: z.string().min(1).max(100).default("Dispatch"),
  // Opt-in for a desktop container: HTTP localhost origin with an all-interfaces bind inside
  // the container. Reachability is then decided by the host port publish, not this process.
  DISPATCH_CONTAINER_LOOPBACK_HTTP: z.enum(["0", "1"]).default("0"),
});

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  let piStorage: PiStorageConfig = { kind: "sqlite" };
  if (parsed.DISPATCH_PI_STORAGE === "postgres") {
    if (!environment.DISPATCH_DATA_DIR || !parsed.DISPATCH_POSTGRES_URL || !parsed.DISPATCH_POSTGRES_STORE_ID) {
      throw new Error("PostgreSQL mode requires explicit DISPATCH_DATA_DIR, DISPATCH_POSTGRES_URL and DISPATCH_POSTGRES_STORE_ID");
    }
    try {
      const database = new URL(parsed.DISPATCH_POSTGRES_URL);
      if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname || database.pathname.length < 2 || database.search || database.hash) {
        throw new Error("Invalid database URL");
      }
    } catch {
      // Never put a credential-bearing URL into configuration diagnostics.
      throw new Error("DISPATCH_POSTGRES_URL must be a postgres:// or postgresql:// URL with a host and database, without query parameters or a fragment");
    }
    piStorage = { kind: "postgres", connectionString: parsed.DISPATCH_POSTGRES_URL, storeId: parsed.DISPATCH_POSTGRES_STORE_ID };
  } else if (parsed.DISPATCH_POSTGRES_URL || parsed.DISPATCH_POSTGRES_STORE_ID) {
    throw new Error("PostgreSQL settings require DISPATCH_PI_STORAGE=postgres; refusing silent SQLite fallback");
  }
  const url = new URL(parsed.DISPATCH_ORIGIN);
  if (url.origin !== parsed.DISPATCH_ORIGIN || url.username || url.password) {
    throw new Error("DISPATCH_ORIGIN must be an origin without credentials, a path, or a trailing slash.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("DISPATCH_ORIGIN must use HTTPS, except for loopback development.");
  }
  const containerLoopbackHttp = url.protocol === "http:" && parsed.DISPATCH_CONTAINER_LOOPBACK_HTTP === "1";
  if (url.protocol === "http:" && !containerLoopbackHttp && !["localhost", "127.0.0.1", "::1"].includes(parsed.DISPATCH_HOST)) {
    throw new Error("Loopback HTTP development must bind to localhost, 127.0.0.1, or ::1, or set DISPATCH_CONTAINER_LOOPBACK_HTTP=1 inside a container published only on the host loopback.");
  }
  return {
    origin: url.origin,
    containerLoopbackHttp,
    rpId: url.hostname.replace(/^\[|\]$/g, ""),
    host: parsed.DISPATCH_HOST,
    port: parsed.DISPATCH_PORT,
    stateDir: resolve(parsed.DISPATCH_DATA_DIR),
    piStorage,
    readAllProjectUserIds: parsed.DISPATCH_READ_ALL_PROJECT_USER_IDS.split(",").map(id => id.trim()).filter(Boolean),
    githubConfigFile: parsed.DISPATCH_GITHUB_CONFIG_FILE,
    workspaceDir: resolve(parsed.DISPATCH_WORKSPACE_DIR),
    connectionsFile: resolve(parsed.DISPATCH_AGENT_CONNECTIONS_FILE ?? `${parsed.DISPATCH_DATA_DIR}/agent-connections.json`),
    companyId: parsed.DISPATCH_COMPANY_ID,
    companyName: parsed.DISPATCH_COMPANY_NAME,
  };
}
