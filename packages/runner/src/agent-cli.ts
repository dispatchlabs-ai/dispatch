#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { catalog, loadAgent } from "./definition.js";
import { connectInTerminal } from "./service-terminal.js";
import { terminalError } from "./terminal-output.js";
import type { ClientConnection } from "./client.js";

const usage = `dispatch-agent --root DEFINITIONS catalog
dispatch-agent --socket SOCKET run [--agent AGENT] [--session KEY] [--request-id ID] [--prompt TEXT]
dispatch-agent --config CLIENT.json run [--agent AGENT] [--session KEY] [--history]
dispatch-agent watch --config HOST.json [--session KEY] [--json]

Start the owner explicitly with dispatch-service HOST.json serve, or run() in your application.
Clients never start, replace or upgrade an owner. Disconnect leaves its work running.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: "string" }, config: { type: "string" }, socket: { type: "string" },
    agent: { type: "string" }, session: { type: "string" }, prompt: { type: "string" },
    "request-id": { type: "string" }, history: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) console.log(usage);
  else if (positionals.length !== 1) throw new Error(usage);
  else if (positionals[0] === "catalog") {
    const root = resolve(values.root ?? ".");
    const agents = await Promise.all((await catalog(root)).filter(agent => agent.runnable).map(agent => loadAgent(root, agent.id)));
    console.log(JSON.stringify(agents.map(({ id, description, model, fingerprint }) => ({ id, description, model, fingerprint })), null, 2));
  } else if (positionals[0] === "watch") {
    const { watchCommand } = await import("./watch.js");
    await watchCommand([
      ...(values.config ? ["--config", values.config] : []),
      ...(values.session ? ["--session", values.session] : []), ...(values.json ? ["--json"] : []),
    ]);
  } else if (positionals[0] === "run") {
    const config = values.config ? JSON.parse(await readFile(values.config, "utf8")) : {};
    let connection: ClientConnection;
    if (values.socket ?? config.socket) connection = { socket: resolve(values.socket ?? config.socket) };
    else if (config.url) connection = { url: config.url, ...(config.tokenFile ? {
      headers: { authorization: `Bearer ${(await readFile(config.tokenFile, "utf8")).trim()}` },
    } : {}) };
    else throw new Error("Configure a socket or URL for the running owner. Start it with dispatch-service HOST.json serve.");
    await connectInTerminal({ connection, agent: values.agent, session: values.session,
      prompt: values.prompt, history: values.history, requestId: values["request-id"] });
  } else throw new Error(usage);
} catch (error) { console.error(terminalError(error).message); process.exitCode = 1; }
