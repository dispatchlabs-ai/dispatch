import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const apiPort = process.env.DISPATCH_PORT ?? "3001";
const webPort = process.env.DISPATCH_WEB_PORT ?? "5173";
const environment = {
  ...process.env,
  DISPATCH_ORIGIN: process.env.DISPATCH_ORIGIN ?? `http://localhost:${webPort}`,
  DISPATCH_DATA_DIR: process.env.DISPATCH_DATA_DIR ?? resolve(root, ".local/state/dispatch"),
  DISPATCH_PORT: apiPort,
  DISPATCH_HOST: "127.0.0.1",
  DISPATCH_SERVE_CLIENT: "false",
};
const children: ChildProcess[] = [];
let stopping = false;
function stop(exitCode = 0) {
  if (stopping) return;
  stopping = true;
  process.exitCode = exitCode;
  for (const child of children) child.kill("SIGTERM");
}
function launch(args: string[], cwd: string) {
  const child = spawn(process.execPath, args, { cwd, env: environment, stdio: "inherit" });
  children.push(child);
  child.on("error", (error) => { console.error(error.message); stop(1); });
  child.on("exit", (code, signal) => { if (!stopping) stop(code ?? (signal ? 1 : 0)); });
}
// Do not watch/restart the backend on frontend edits; Pi has one persistent owner.
launch(["--import", "tsx", "packages/web/server/index.ts"], root);
launch([resolve(root, "node_modules/@react-router/dev/bin.cjs"), "dev", "--port", webPort], resolve(root, "packages/web"));
process.once("SIGINT", () => stop());
process.once("SIGTERM", () => stop());
