import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
process.env.DISPATCH_DATA_DIR ??= resolve(root, ".local/state/dispatch");
process.env.DISPATCH_ORIGIN ??= `http://localhost:${process.env.DISPATCH_WEB_PORT ?? "5173"}`;
await import("../packages/web/server/auth-cli.js");
