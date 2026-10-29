#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { createModels } from "@earendil-works/pi-ai/models";
import { catalog, loadAgent } from "./definition.js";
import { createRunner } from "./index.js";
import { refreshGatewayModels } from "./gateway.js";
import { modelRetrySettings } from "./retry.js";
import type { ServiceConfig } from "./service.js";
import { chatInTerminal } from "./terminal.js";
import { terminalError } from "./terminal-output.js";

const usage = `dispatch-agent --root DEFINITIONS catalog
dispatch-agent --root DEFINITIONS run --config HOST.json --agent AGENT [--session KEY] --prompt TEXT
dispatch-agent --root DEFINITIONS run --config HOST.json --agent AGENT --session KEY --history

Each session owns a separate process state directory. No listener or schedules.
Use --update-definitions only for an explicit idle definition migration.
SIGINT/SIGTERM suspend native work; they do not undo external effects.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" }, config: { type: "string" }, agent: { type: "string" },
      session: { type: "string" }, prompt: { type: "string" }, history: { type: "boolean" },
      "update-definitions": { type: "boolean" }, help: { type: "boolean" },
    },
  });
  if (values.help) console.log(usage);
  else {
    if (!values.root || positionals.length !== 1) throw new Error(usage);
    const root = resolve(values.root);
    if (positionals[0] === "catalog") {
      const agents = await Promise.all((await catalog(root)).filter(agent => agent.runnable)
        .map(agent => loadAgent(root, agent.id)));
      console.log(JSON.stringify(agents.map(({ id, description, model, fingerprint }) =>
        ({ id, description, model, fingerprint })), null, 2));
    } else {
      if (positionals[0] !== "run" || !values.config || !values.agent
        || (values.history ? values.prompt !== undefined || !values.session : !values.prompt?.trim())) {
        throw new Error(usage);
      }
      const session = values.session ?? randomUUID();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(session)) throw new Error("Invalid session key.");
      const config: Pick<ServiceConfig, "stateRoot" | "cwd" | "namespace" | "gateway" | "retry"> =
        JSON.parse(await readFile(values.config, "utf8"));
      for (const field of ["stateRoot", "cwd"] as const) {
        if (typeof config[field] !== "string" || !isAbsolute(config[field])) throw new Error(`${field} must be an absolute path.`);
      }
      if (!config.gateway?.origin || !isAbsolute(config.gateway.credentialFile)) throw new Error("Supply gateway.origin and an absolute gateway.credentialFile.");
      const names = new Set<string>();
      const include = async (id: string) => {
        if (names.has(id)) return;
        names.add(id);
        for (const recipient of (await loadAgent(root, id)).messages ?? []) await include(recipient);
      };
      await include(values.agent);
      const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
      const { key } = JSON.parse(await readFile(config.gateway.credentialFile, "utf8"));
      await refreshGatewayModels(config.gateway.origin, models, key, config.gateway.aliases);
      await chatInTerminal({
        root, stateRoot: join(config.stateRoot, session), cwd: config.cwd,
        runner: createRunner({ namespace: config.namespace }), models, names: [...names],
        agent: values.agent, session, prompt: values.prompt, history: values.history,
        updateDefinitions: values["update-definitions"], settings: modelRetrySettings(config.retry),
      });
    }
  }
} catch (error) {
  console.error(terminalError(error).message);
  process.exitCode = 1;
}
