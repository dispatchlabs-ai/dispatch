import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { ProcessScope } from "./process-scope.js";

/** Trusted host configuration, independent of provider or model protocol. */
export type ModelProcessConfig = {
  command: string;
  args: string[];
  /** {port} is allocated on loopback; the same endpoint is retained across process restarts. */
  baseUrl: string;
  readyUrl: string;
};

export async function modelProcess(config: ModelProcessConfig, cwd: string) {
  if (typeof config.command !== "string" || !config.command.trim() || !Array.isArray(config.args) || config.args.some(arg => typeof arg !== "string")
    || typeof config.baseUrl !== "string" || typeof config.readyUrl !== "string") throw new Error("A model process needs command, args, baseUrl and readyUrl.");
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a model server port.");
  const port = String(address.port);
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  const expand = (text: string) => text.replaceAll("{port}", port);
  const launch = { ...config, args: config.args.map(expand), baseUrl: expand(config.baseUrl), readyUrl: expand(config.readyUrl) };
  for (const value of [launch.baseUrl, launch.readyUrl]) {
    const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password) throw new Error("Managed model processes need loopback HTTP endpoints without embedded credentials.");
  }
  let worker: ProcessScope | undefined;
  let starting: Promise<void> | undefined;
  let ready = false;
  let closed = false;
  const ensure = (signal?: AbortSignal): Promise<void> => {
    signal?.throwIfAborted();
    if (closed) return Promise.reject(new Error("Model process is closed."));
    if (ready) return Promise.resolve();
    return starting ??= (async () => {
      // An existing listener belongs to someone else. Never claim it as our child.
      const endpoint = new URL(launch.baseUrl);
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once("error", () => reject(new Error("Managed model endpoint is already in use or cannot be bound. Use baseUrl for an external server.")));
        probe.listen(Number(endpoint.port || 80), endpoint.hostname.replace(/^\[|\]$/g, ""), resolve);
      });
      await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
      signal?.throwIfAborted();
      if (closed) throw new Error("Model process is closed.");
      const owned = new ProcessScope(fileURLToPath(new URL("./model-process-worker.js", import.meta.url)), [], { cwd });
      worker = owned;
      void owned.exited.then(() => {
        if (worker === owned) { worker = undefined; ready = false; }
      });
      try {
        await owned.request("start", launch, signal);
        if (worker !== owned || closed) throw new Error("Model process stopped during startup.");
        ready = true;
      }
      catch (error) { await owned.close(); throw error; }
    })().finally(() => { starting = undefined; });
  };
  return {
    baseUrl: launch.baseUrl,
    ensure,
    close: async () => { closed = true; await worker?.close(); await starting?.catch(() => {}); },
  };
}
