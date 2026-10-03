import { resolve } from "node:path";
import { z } from "zod";

const environmentSchema = z.object({
  DISPATCH_ORIGIN: z.url().default("http://localhost:3001"),
  DISPATCH_HOST: z.string().min(1).default("127.0.0.1"),
  DISPATCH_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  DISPATCH_DATA_DIR: z.string().min(1).default(".local/state/dispatch"),
  DISPATCH_COMPANY_ID: z.string().min(1).max(100).default("dispatch"),
  DISPATCH_COMPANY_NAME: z.string().min(1).max(100).default("Dispatch"),
});

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = environmentSchema.parse(environment);
  const url = new URL(parsed.DISPATCH_ORIGIN);
  if (url.origin !== parsed.DISPATCH_ORIGIN || url.username || url.password) {
    throw new Error("DISPATCH_ORIGIN must be an origin without credentials, a path, or a trailing slash.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new Error("DISPATCH_ORIGIN must use HTTPS, except for loopback development.");
  }
  if (url.protocol === "http:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.DISPATCH_HOST)) {
    throw new Error("Loopback HTTP development must bind to localhost, 127.0.0.1, or ::1.");
  }
  return {
    origin: url.origin,
    rpId: url.hostname.replace(/^\[|\]$/g, ""),
    host: parsed.DISPATCH_HOST,
    port: parsed.DISPATCH_PORT,
    stateDir: resolve(parsed.DISPATCH_DATA_DIR),
    companyId: parsed.DISPATCH_COMPANY_ID,
    companyName: parsed.DISPATCH_COMPANY_NAME,
  };
}
