// Trusted consumer adapters are isolated from other installations' process state.
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { Runtime } from "./runtime.js";
const port = parentPort!;
const { module, configFile, sources, defaultSource } = workerData;
const runtime: Runtime = await (await import(pathToFileURL(module).href)).openRuntime({ configFile, sources, defaultSource });
port.postMessage({ ready: true, agents: runtime.service.agents });
port.on("message", async ({ id, method, args }) => {
  try {
    let result;
    if (method === "snapshot") result = await runtime.presentation.snapshot(...args as [string]);
    else if (method === "close") await runtime.close();
    else if (["has", "sources", "list", "create", "submit", "stop", "artifact"].includes(method))
      result = await (runtime.service as any)[method](...args);
    else throw new Error("Unsupported adapter operation.");
    port.postMessage({ id, result });
    if (method === "close") port.close();
  } catch (error) {
    port.postMessage({ id, error: (error as Error).message, status: (error as { status?: number }).status });
  }
});
