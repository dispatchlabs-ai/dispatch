#!/usr/bin/env node
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { catalog, loadAgent } from "./definition.js";
import { connectInTerminal } from "./service-terminal.js";
import { terminalError, terminalText } from "./terminal-output.js";
import type { ClientConnection } from "./client.js";
import { localHostConfig } from "./local-host.js";
import { localHostPaths, readHostConfig, readClientConnection, projectHostConfig, readProjectHostConfig } from "./host-config.js";

const usage = `dispatch serve [--root DIRECTORY] [--state DIRECTORY] [--socket SOCKET] [--demo]
dispatch serve --config HOST.json
dispatch chat [--root DIRECTORY] [--state DIRECTORY] [--agent NAME] [--session KEY] [--prompt TEXT] [--history]
dispatch catalog [--root DIRECTORY]
dispatch login PROVIDER [--api-key] [--no-browser]
dispatch logout PROVIDER
dispatch auth
dispatch providers list [--config HOST.json] [--json]
dispatch providers add [PROVIDER] [--api-key] [--no-browser] [--agent NAME]
dispatch providers add --module ./provider.ts [--export FACTORY] [--base-url URL]
dispatch models list [--provider ID] [--json]
dispatch models use [--agent NAME] [--provider ID] [--model ID]

Create agent.md with YAML frontmatter and instructions:
---
description: A helpful assistant
model: { provider: openai, id: gpt-6.1-sol }
---
Answer clearly.

Run dispatch providers add to connect a provider, then dispatch serve.
Provider setup saves host.json; serve and chat read it automatically.
API keys in the host environment also work (OPENAI_API_KEY, ANTHROPIC_API_KEY).
Use --demo for synthetic replies without credentials. State is saved in .state/;
add that directory to .gitignore. In another terminal here, run dispatch chat.
Node 24.22.1 or newer is required. Nix is optional.

Advanced clients:
dispatch-agent --root DEFINITIONS catalog
dispatch-agent --socket SOCKET run [--agent AGENT] [--session KEY] [--request-id ID] [--prompt TEXT]
dispatch-agent --config CLIENT.json run [--agent AGENT] [--session KEY] [--history]
dispatch-agent watch --config HOST.json [--session KEY] [--json]

Start the owner explicitly with dispatch serve, dispatch-service HOST.json serve, or run() in your application.
Clients never start, replace or upgrade an owner. Disconnect leaves its work running.`;

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    root: { type: "string" }, state: { type: "string" }, config: { type: "string" }, socket: { type: "string" }, demo: { type: "boolean" },
    agent: { type: "string" }, session: { type: "string" }, prompt: { type: "string" },
    "request-id": { type: "string" }, history: { type: "boolean" }, json: { type: "boolean" }, help: { type: "boolean" },
    "api-key": { type: "boolean" }, "no-browser": { type: "boolean" },
    provider: { type: "string" }, model: { type: "string" }, module: { type: "string" }, export: { type: "string" }, "base-url": { type: "string" },
  } });
  if (values.demo && positionals[0] !== "serve") throw new Error("--demo is a host option: use dispatch serve --demo, then dispatch chat.");
  if ((values["api-key"] || values["no-browser"]) && !["login", "providers"].includes(positionals[0])) throw new Error("--api-key and --no-browser are sign-in options.");
  if (values.help) console.log(usage);
  else if ((positionals[0] === "login" || positionals[0] === "logout") && positionals.length === 2) {
    const { loginCommand, logoutCommand } = await import("./login-cli.js");
    if (positionals[0] === "login") await loginCommand(positionals[1], { apiKey: values["api-key"], noBrowser: values["no-browser"] });
    else await logoutCommand(positionals[1]);
  }
  else if (positionals[0] === "providers" && ["list", "add"].includes(positionals[1]) && positionals.length <= 3) {
    const { providerCommand } = await import("./provider-cli.js");
    await providerCommand(positionals[1] as "list" | "add", positionals[2], { ...values, apiKey: values["api-key"], noBrowser: values["no-browser"], baseUrl: values["base-url"] });
  }
  else if (positionals[0] === "models" && ["list", "use"].includes(positionals[1]) && positionals.length === 2) {
    const { modelCommand } = await import("./provider-cli.js");
    await modelCommand(positionals[1] as "list" | "use", values);
  }
  else if (positionals.length !== 1) throw new Error(usage);
  else if (positionals[0] === "auth") {
    const { authStatus } = await import("./login-cli.js");
    await authStatus();
  }
  else if (positionals[0] === "serve") {
    if (values.config && (values.root || values.state || values.socket || values.demo)) throw new Error("Use --config HOST.json on its own, or select local host options.");
    const config = values.config ? await readHostConfig(values.config) : await localHostConfig(values);
    process.chdir(config.cwd);
    const { startServiceInTerminal } = await import("./service-lifecycle.js");
    const host = await startServiceInTerminal(config);
    let connectionHint = "Connect using your HTTPS client configuration.";
    if (config.socket) {
      connectionHint = values.config
        ? "In another terminal, run npx dispatch chat with the same --config file."
        : `In ${config.root}, connect with npx dispatch chat${values.state ? ` --state ${JSON.stringify(config.stateRoot)}` : ""}${values.socket ? ` --socket ${JSON.stringify(config.socket)}` : ""}.`;
    }
    console.log(terminalText(`${config.demo ? "Demo host" : "Host"} ready: ${host.service.agents.map(agent => agent.id).join(", ")}\nState: ${config.stateRoot}\n${config.socket ? `Socket: ${config.socket}\n` : ""}${connectionHint}\nPress Ctrl-C to stop the host; saved conversations remain.`));
  } else if (positionals[0] === "catalog") {
    const root = resolve(values.root ?? ".");
    const agents = await Promise.all((await catalog(root)).filter(agent => agent.runnable).map(agent => loadAgent(root, agent.id)));
    console.log(JSON.stringify(agents.map(({ id, description, model, fingerprint, mcp }) => ({ id, description, model, fingerprint, ...(mcp ? { mcp } : {}) })), null, 2));
  } else if (positionals[0] === "watch") {
    const { watchCommand } = await import("./watch.js");
    await watchCommand([
      ...(values.config ? ["--config", values.config] : []),
      ...(values.session ? ["--session", values.session] : []), ...(values.json ? ["--json"] : []),
    ]);
  } else if (positionals[0] === "run" || positionals[0] === "chat") {
    let connection: ClientConnection;
    if (values.socket) connection = { socket: resolve(values.socket) };
    else if (values.config) connection = await readClientConnection(values.config);
    else if (positionals[0] === "chat") {
      const configured = await readProjectHostConfig(values);
      connection = configured?.socket ? { socket: configured.socket }
        : configured ? await readClientConnection(await projectHostConfig(values.root)) : { socket: (await localHostPaths(values)).socket };
    }
    else throw new Error("Configure a socket or URL for the running owner. Start it with dispatch serve.");
    try {
      await connectInTerminal({ connection, agent: values.agent, session: values.session ?? (positionals[0] === "chat" ? "main" : undefined),
        prompt: values.prompt, history: values.history, requestId: values["request-id"] });
    } catch (error) {
      if (positionals[0] === "chat" && ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        throw new Error("No host is listening at this connection. Start npx dispatch serve in another terminal, then reconnect. Use --history to inspect saved messages before resending.");
      }
      throw error;
    }
  } else throw new Error(usage);
} catch (error) { console.error(terminalError(error).message); process.exitCode = 1; }
