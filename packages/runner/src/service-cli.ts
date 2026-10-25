#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { startService, serviceRequest, type ServiceCommand, type ServiceConfig } from "./service.js";

const [configPath, action, ...args] = process.argv.slice(2);
try {
  if (!configPath || !action) throw new Error("Usage: dispatch-service CONFIG serve|agents|chats|create AGENT [TITLE]|send CHAT TEXT|snapshot CHAT|stop CHAT|receipt CHAT SUBMISSION");
  const config: ServiceConfig = JSON.parse(await readFile(configPath, "utf8"));
  if (action === "serve") {
    const service = await startService(config);
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
      void service.close().then(() => process.exit(0), error => { console.error(String(error)); process.exit(1); });
    });
    console.log(JSON.stringify({ event: "service-started", agents: service.service.agents.map(agent => agent.id) }));
  } else {
    let command: ServiceCommand;
    switch (action) {
      case "agents": case "chats": case "status": command = { method: action }; break;
      case "idle": command = { method: "status" }; break;
      case "create": command = { method: action, agent: args[0], key: randomUUID(), title: args.slice(1).join(" ") || undefined }; break;
      case "send": command = { method: action, id: args[0], text: args.slice(1).join(" "), requestId: randomUUID() }; break;
      case "snapshot": case "stop": command = { method: action, id: args[0] }; break;
      case "receipt": command = { method: action, id: args[0], submissionId: Number(args[1]) }; break;
      default: throw new Error("Unknown command.");
    }
    const result = await serviceRequest(config.socket, command);
    if (action === "idle" && (result as { busy: boolean }).busy) throw new Error("The service has unfinished work; leave it running.");
    console.log(JSON.stringify(result, null, 2));
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
