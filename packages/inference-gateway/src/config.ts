import { z } from "zod";

const id = z.string().regex(/^[a-z0-9][a-z0-9_-]*$/);
export const configSchema = z.object({
  audience: z.url(),
  region: z.string().default("us-east-1"),
  host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8787),
  sessionSecretId: z.string().min(1),
  connections: z.array(z.object({
    id,
    provider: z.string().min(1),
    secretId: z.string().min(1),
    allowAmbientAuth: z.boolean().default(false),
  }).strict()),
  principals: z.array(z.object({
    id,
    aws: z.object({ accountId: z.string().regex(/^\d{12}$/), roleId: z.string().regex(/^AROA[A-Z0-9]+$/) }).strict(),
    grants: z.record(z.union([id, z.literal("*")]), z.array(z.string().min(1))),
  }).strict()),
}).strict();

export type GatewayConfig = z.infer<typeof configSchema>;
export type ConnectionConfig = GatewayConfig["connections"][number];
export type Principal = GatewayConfig["principals"][number];

export function gatewayOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("The gateway requires HTTPS (except on loopback)");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The gateway URL must be an origin without credentials, path, query, or fragment");
  }
  return url.origin;
}

export function parseConfig(value: unknown): GatewayConfig {
  const config = configSchema.parse(value);
  config.audience = gatewayOrigin(config.audience);
  for (const entries of [config.connections, config.principals]) {
    if (new Set(entries.map((entry) => entry.id)).size !== entries.length) throw new Error("Duplicate configuration IDs");
  }
  const identities = config.principals.map((principal) => `${principal.aws.accountId}:${principal.aws.roleId}`);
  if (new Set(identities).size !== identities.length) throw new Error("Duplicate AWS principals");
  for (const principal of config.principals) {
    for (const connection of Object.keys(principal.grants)) {
      if (connection !== "*" && !config.connections.some((item) => item.id === connection)) throw new Error(`Unknown connection: ${connection}`);
    }
  }
  return config;
}

export function permitted(principal: Principal, connection: string, model: string): boolean {
  const grants = principal.grants[connection] ?? principal.grants["*"] ?? [];
  return grants.includes("*") || grants.includes(model);
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
