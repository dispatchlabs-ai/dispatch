import { startService, type ServiceConfig } from "./service.js";
import { terminalError } from "./terminal-output.js";

/** Signal ownership starts before provider startup, including a server's readiness wait. */
export async function startServiceInTerminal(config: ServiceConfig) {
  const controller = new AbortController();
  let host: Awaited<ReturnType<typeof startService>> | undefined;
  const stop = () => {
    controller.abort();
    if (host) void host.close().then(() => process.exit(0), error => {
      console.error(terminalError(error).message); process.exit(1);
    });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try { host = await startService(config, { signal: controller.signal }); return host; }
  catch (error) {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    if (controller.signal.aborted) throw new Error("Host startup cancelled.");
    throw error;
  }
}
