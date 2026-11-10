// Trusted consumer adapters are isolated from other installations' process state.
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import type { Runtime } from "./runtime.js";
const port = parentPort!;
const { module, configFile, sources, defaultSource, export: factory = "openRuntime", options } = workerData;
const create = (await import(pathToFileURL(module).href))[factory];
if (typeof create !== "function") throw new Error("Trusted adapter must export its configured runtime factory.");
const runtime: Runtime = await create({ ...options, configFile, sources, defaultSource });
port.postMessage({ ready: true, agents: runtime.service.agents });
port.on("message", async ({ id, method, args }) => {
  try {
    let result;
    if (method === "agents") result = await (runtime.catalog?.() ?? Promise.resolve(runtime.service.agents));
    else if (method === "resolveChat") {
      if (!runtime.resolveChat) throw new Error("This installation does not support native conversation links.");
      result = await runtime.resolveChat(args[0]);
    }
    else if (method === "snapshot") result = await runtime.presentation.snapshot(...args as [string]);
    else if (method === "close") await runtime.close();
    else if (method === "has" && !runtime.service.has) result = (await runtime.service.list()).some(chat => chat.id === args[0]);
    else if (["has", "sources", "list", "create", "submit", "stop", "artifact"].includes(method))
      result = await (runtime.service as any)[method](...args);
    else throw new Error("Unsupported adapter operation.");
    port.postMessage({ id, result });
    if (method === "close") port.close();
  } catch (error) {
    port.postMessage({ id, error: (error as Error).message, status: (error as { status?: number }).status });
  }
});
