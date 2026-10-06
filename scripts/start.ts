import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.env.DISPATCH_WEB_PORT ?? "5173";
const child = spawn(process.execPath, ["packages/web/build/service/server/index.js"], {
  cwd: root, stdio: "inherit",
  env: {
    ...process.env,
    DISPATCH_PORT: port,
    DISPATCH_ORIGIN: process.env.DISPATCH_ORIGIN ?? `http://localhost:${port}`,
    DISPATCH_DATA_DIR: process.env.DISPATCH_DATA_DIR ?? resolve(root, ".local/state/dispatch"),
    DISPATCH_WORKSPACE_DIR: process.env.DISPATCH_WORKSPACE_DIR ?? root,
  },
});
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
process.once("SIGINT", () => child.kill("SIGINT"));
process.once("SIGTERM", () => child.kill("SIGTERM"));
