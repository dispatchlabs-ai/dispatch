// One native owner per worker: Dispatch's trusted session environment binding is
// process-global; worker env isolation keeps inspection tools session-correct.
import { dirname } from "node:path";
import { parentPort, workerData } from "node:worker_threads";
import * as runner from "@dispatch/runner";
import { createModels } from "@earendil-works/pi-ai/models";
import { connectHostModels } from "@dispatch/runner/host-models";
import { serviceSettings } from "@dispatch/runner/settings";
import type { LocalConfig } from "./config.js";
import { createProvenance } from "./provenance.js";
import { checkSuspendedWork } from "./admission.js";
import { AdmissionError } from "./config.js";
const port = parentPort!;
const { path, namespace, names } = workerData;
const { definitionsRoot, host } = workerData.config as LocalConfig;
process.env.DISPATCH_SESSION_STATE_ROOT = path;

let service: any, connection: any, models: ReturnType<typeof createModels>;
try {
  models = createModels({
    authContext: { env: async () => undefined, fileExists: async () => false },
  });
  connection = await connectHostModels(host, models);
  for (const provider of models.getProviders())
    models.setProvider(runner.withPrivateProviderErrors(provider));
  const native = runner.createRunner({ namespace });
  service = await native.ChatService.open({
    root: definitionsRoot,
    stateRoot: path,
    // Web shares the installation's session root with the CLI: same single Pi Durable.
    runtimeRoot: dirname(path),
    cwd: host.cwd,
    names,
    models,
    demo: false,
    resume: false,
    definitionResources: true,
    settings: serviceSettings(host),
  });
  port.postMessage({ ready: true });
} catch {
  await service?.close().catch(() => {});
  await connection?.close().catch(() => {});
  port.postMessage({ failed: true });
  port.close();
}
// Serialize mutations including their policy check. Native lock ownership prevents
// external admission; queued RPCs must not race paused-state inspection/resume.
let mutation = Promise.resolve();
port.on("message", ({ id, method, args }) => {
  const execute = async () => {
    try {
      let result;
      if (method === "close") {
        await service.close();
        await connection.close();
      } else if (method === "resolve") {
        await service.resolve(...args);
        result = true;
      } else if (method === "snapshot") {
        const { conversation } = await service.resolve(...args);
        result = await createProvenance(
          conversation,
          runner.context,
          namespace,
        )(await service.snapshot(...args));
      } else {
        const paused: string[] = [];
        for (const [agent, host] of service.hosts)
          if (
            (await host.harness.inspect(runner.context)).scheduling === "paused"
          )
            paused.push(agent);
        const selected =
          method === "create"
            ? undefined
            : (() => {
                const split = args[0].lastIndexOf(":");
                return {
                  agent: args[0].slice(0, split),
                  conversationId: Number(args[0].slice(split + 1)),
                };
              })();
        // create itself does not resume, but must not establish a new chat in an
        // already suspended, conflicted session which a subsequent send enables.
        checkSuspendedWork(
          path,
          method === "stop"
            ? paused.filter((agent) => agent === selected?.agent)
            : paused,
          selected,
        );
        if (method === "submit") {
          const files = args[5] ?? [];
          runner.prepareContent(args[1], files);
          if (files.some((file: runner.AttachmentFile) => file.mimeType.startsWith("image/"))) {
            const agent = service.agents.find((agent: any) => agent.id === selected?.agent);
            if (!models.getModel(agent.model.provider, agent.model.id)?.input.includes("image"))
              throw new AdmissionError("This authored model does not accept images. Remove the image or choose an image-capable agent.");
          }
        }
        if (method === "submit")
          for (const host of service.hosts.values()) host.harness.resume();
        result = await service[method](...args);
      }
      port.postMessage({ id, result });
      if (method === "close") port.close();
    } catch (error) {
      port.postMessage({
        id,
        ...((error instanceof AdmissionError || error instanceof runner.ContentError)
          ? { error: error.message, status: 409 }
          : {
              error:
                "Native request failed. Preserve the request identity on uncertain delivery; inspect the original native owner/provider and retry.",
            }),
      });
    }
  };
  if (method === "snapshot" || method === "resolve") void execute();
  else mutation = mutation.then(execute, execute);
});
