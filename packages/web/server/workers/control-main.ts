import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { z } from "zod";
import { DockerContainerDriver } from "./docker-driver.js";
import { WorkerLauncher } from "./launcher.js";
import { createLauncherControl } from "./control.js";
import { workerToken } from "./identity.js";

// Operator-only file: may contain worker environment secrets. Never log its contents.
const filename = process.env.DISPATCH_LAUNCHER_CONFIG_FILE;
if (!filename) throw new Error("DISPATCH_LAUNCHER_CONFIG_FILE is required.");
const config = z.object({
  installationId: z.string().min(1).max(200), stateDir: z.string().startsWith("/").optional(),
  postgres: z.object({ urlFile: z.string().startsWith("/"), recoverOwnerId: z.string().uuid().optional() }).strict().optional(),
  tokenFile: z.string().startsWith("/"), workerKeyFile: z.string().startsWith("/"), host: z.string().default("127.0.0.1"),
  port: z.number().int().min(1).max(65535).default(8830), driver: z.record(z.string(), z.unknown()),
}).strict().parse(JSON.parse(await readFile(filename, "utf8")));
const token = (await readFile(config.tokenFile, "utf8")).trim();
// Driver performs its own strict runtime validation, including every required field.
const workerKey = (await readFile(config.workerKeyFile, "utf8")).trim();
const driver = new DockerContainerDriver({ ...config.driver, installationId: config.installationId } as ConstructorParameters<typeof DockerContainerDriver>[0], spec => ({
  DISPATCH_WORKER_TOKEN: workerToken(workerKey, config.installationId, spec),
}));
if (Boolean(config.stateDir) === Boolean(config.postgres)) throw new Error("Select exactly one launcher stateDir or postgres configuration.");
const launcher = config.postgres
  ? await WorkerLauncher.openPostgres({ connectionString: (await readFile(config.postgres.urlFile, "utf8")).trim(), installationId: config.installationId, driver, recoverOwnerId: config.postgres.recoverOwnerId })
  : await WorkerLauncher.open({ stateDir: config.stateDir!, installationId: config.installationId, driver });
const app = createLauncherControl(launcher, token);
const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port });
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  server.close();
  // Controller replacement never silently kills workers. Operators explicitly drain first.
  await launcher.close();
  if ("closeAllConnections" in server) server.closeAllConnections();
}
process.once("SIGTERM", () => { void close(); });
process.once("SIGINT", () => { void close(); });
