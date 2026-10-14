import { readFile } from "node:fs/promises";
import { z } from "zod";
import { EcsContainerDriver } from "./ecs-driver.js";
import { DockerContainerDriver } from "./docker-driver.js";
import { WorkerLauncher, type ContainerDriver } from "./launcher.js";
import { createLauncherControl } from "./control.js";
import { validateBackendCa } from "./transport.js";
import { workerToken } from "./identity.js";

// Operator-only file: may contain worker environment secrets. Never log its contents.
export async function openLauncherOwner() {
const filename = process.env.DISPATCH_LAUNCHER_CONFIG_FILE;
if (!filename) throw new Error("DISPATCH_LAUNCHER_CONFIG_FILE is required.");
const config = z.object({
  installationId: z.string().min(1).max(200), stateDir: z.string().startsWith("/").optional(),
  backendCaFile: z.string().startsWith("/").optional(),
  postgres: z.object({ caFile: z.string().startsWith("/").optional(), urlFile: z.string().startsWith("/"), recoverOwnerId: z.string().uuid().optional() }).strict().optional(),
  tokenFile: z.string().startsWith("/"), workerKeyFile: z.string().startsWith("/"), host: z.string().default("127.0.0.1"),
  driverType: z.enum(["docker", "ecs"]).default("docker"),
  port: z.number().int().min(1).max(65535).default(8830), driver: z.record(z.string(), z.unknown()),
}).strict().parse(JSON.parse(await readFile(filename, "utf8")));
const token = (await readFile(config.tokenFile, "utf8")).trim();
// Driver performs its own strict runtime validation, including every required field.
const workerKey = (await readFile(config.workerKeyFile, "utf8")).trim();
const backendCa = config.backendCaFile === undefined ? undefined : await readFile(config.backendCaFile, "utf8");
if (backendCa !== undefined) {
  validateBackendCa(backendCa);
  const origin = (config.driver.environment as Record<string, string> | undefined)?.DISPATCH_BACKEND_INTERNAL_URL;
  if (!origin || new URL(origin).protocol !== "https:") throw new Error("Backend CA requires an HTTPS backend URL.");
}
const workerEnvironment = (spec: import("./launcher.js").ContainerSpec) => ({
  DISPATCH_WORKER_TOKEN: workerToken(workerKey, config.installationId, spec),
  ...(backendCa === undefined ? {} : { DISPATCH_BACKEND_CA_PEM: backendCa }),
});
const driver: ContainerDriver = config.driverType === "ecs"
  ? new EcsContainerDriver({ ...config.driver, installationId: config.installationId } as ConstructorParameters<typeof EcsContainerDriver>[0], workerEnvironment)
  : new DockerContainerDriver({ ...config.driver, installationId: config.installationId } as ConstructorParameters<typeof DockerContainerDriver>[0], workerEnvironment);
if (config.driverType === "ecs" && !config.postgres) throw new Error("ECS launcher requires PostgreSQL journal persistence.");
if (Boolean(config.stateDir) === Boolean(config.postgres)) throw new Error("Select exactly one launcher stateDir or postgres configuration.");
const launcher = config.postgres
  ? await WorkerLauncher.openPostgres({ connectionString: (await readFile(config.postgres.urlFile, "utf8")).trim(), ca: config.postgres.caFile === undefined ? undefined : await readFile(config.postgres.caFile, "utf8"), installationId: config.installationId, driver, recoverOwnerId: config.postgres.recoverOwnerId })
  : await WorkerLauncher.open({ stateDir: config.stateDir!, installationId: config.installationId, driver });
const app = createLauncherControl(launcher, token);
let maintaining = false;
const maintain = () => {
  if (maintaining) return;
  maintaining = true;
  void launcher.maintainWarmSpare().catch(() => console.warn("Warm spare reconciliation incomplete; retrying reconciliation."))
    .finally(() => { maintaining = false; });
};
const timer = config.driverType === "ecs" ? setInterval(maintain, 5000) : undefined;
timer?.unref();
if (timer) maintain();
const close = () => { clearInterval(timer); return launcher.close(); };
return { app, host: config.host, port: config.port, retire: close,
  ready: () => launcher.ready(), close };
}
