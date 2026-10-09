import { serve } from "@hono/node-server";
import { createServer as createHttpsServer } from "node:https";
import { once } from "node:events";
import { openBackendOwner } from "./backend-owner.js";

if (process.env.DISPATCH_CONTROLLER_CONFIG_FILE) {
  const { serveRollingController } = await import("./controller-main.js");
  await serveRollingController("backend", openBackendOwner);
} else {
const owner = await openBackendOwner();
let server: ReturnType<typeof serve>;
try {
  const listener = { fetch: owner.app.fetch, hostname: owner.host, port: owner.port };
  server = owner.tls
    ? serve({ ...listener, createServer: createHttpsServer, serverOptions: owner.tls })
    : serve(listener);
  await once(server, "listening");
} catch (error) {
  await owner.retire();
  throw error;
}
let shutdown: Promise<void> | undefined;
function requestShutdown() {
  void (shutdown ??= owner.close().then(() => new Promise<void>((resolve, reject) => {
    server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    if ("closeAllConnections" in server) server.closeAllConnections();
  })).catch(error => { shutdown = undefined; throw error; })).catch(() => {
    process.exitCode = 1;
    console.error("Backend shutdown incomplete; operator intervention required.");
  });
}
process.on("SIGTERM", requestShutdown);
process.on("SIGINT", requestShutdown);
}
