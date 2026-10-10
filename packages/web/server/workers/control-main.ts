import { closeTelemetry } from "../telemetry.js";
import { serve } from "@hono/node-server";
import { openLauncherOwner } from "./launcher-owner.js";
if (process.env.DISPATCH_CONTROLLER_CONFIG_FILE) {
  const { serveRollingController } = await import("./controller-main.js");
  await serveRollingController("launcher", openLauncherOwner);
} else {
const owner = await openLauncherOwner();
const server = serve({ fetch: owner.app.fetch, hostname: owner.host, port: owner.port });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  await owner.close();
  await closeTelemetry();
  if ("closeAllConnections" in server) server.closeAllConnections();
}
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
}
