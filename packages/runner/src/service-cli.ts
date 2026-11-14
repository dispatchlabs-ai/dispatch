#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { connectClient, type ServiceCommand, connectInTerminal } from "./service.js";
import { readHostConfig } from "./host-config.js";

const [configPath, action, ...args] = process.argv.slice(2);
try {
  if (!configPath || !action) throw new Error("Usage: dispatch-service CONFIG serve|connect [CHAT]|command COMMAND.json|agents|chats|schedules|status|idle|create AGENT [TITLE]|send CHAT TEXT|message FROM TO TEXT|ask FROM TO TEXT|message-status FROM TASK|snapshot CHAT|compact CHAT [INSTRUCTIONS]|download CHAT ARTIFACT DESTINATION|stop CHAT|receipt CHAT SUBMISSION");
  const config = await readHostConfig(configPath);
  if (action === "serve") {
    // Provider subprocesses inherit the service directory; keep it the configured workspace.
    process.chdir(config.cwd);
    const { startServiceInTerminal } = await import("./service-lifecycle.js");
    const service = await startServiceInTerminal(config);
    console.log(JSON.stringify({ event: "service-started", agents: service.service.agents.map(agent => agent.id) }));
  } else {
    if (!config.socket) throw new Error("These commands require a socket. For HTTPS use dispatch-agent --config CLIENT.json run or connectClient().");
    const socket = config.socket;
    const client = await connectClient({ socket });
    try {
      if (action === "connect") {
        await connectInTerminal({ client, id: args[0] });
      } else if (action === "command") {
        // Machine callers retain their own native create/request identities and file bytes.
        if (args.length !== 1) throw new Error("Usage: command COMMAND.json");
        const command = JSON.parse(await readFile(args[0], "utf8")) as ServiceCommand;
        console.log(JSON.stringify(await client.command(command), null, 2));
      } else {
        let command: ServiceCommand;
        switch (action) {
          case "agents": case "chats": case "status": case "schedules": command = { method: action }; break;
          case "idle": command = { method: "status" }; break;
          case "create": command = { method: action, agent: args[0], key: randomUUID(), title: args.slice(1).join(" ") || undefined }; break;
          case "send": command = { method: action, id: args[0], text: args.slice(1).join(" "), requestId: randomUUID() }; break;
          case "message": case "ask":
            if (!args[0] || !args[1]?.includes(":") || !args.slice(2).join(" ").trim()) throw new Error("Usage: message|ask FROM TO TEXT (use full instance IDs).");
            command = { method: "message", from: args[0], requestId: randomUUID(),
              message: { agent: args[1].split(":")[0], instance: args[1], text: args.slice(2).join(" "), reply: action === "ask" } };
            break;
          case "message-status": command = { method: action, from: args[0], taskId: Number(args[1]) }; break;
          case "snapshot": case "stop": command = { method: action, id: args[0] }; break;
          case "compact": command = { method: action, id: args[0], instructions: args.slice(1).join(" ") || undefined }; break;
          case "download":
            if (!args[2]) throw new Error("Usage: download CHAT ARTIFACT DESTINATION (a new file).");
            command = { method: "artifact", id: args[0], artifactId: args[1] }; break;
          case "receipt": command = { method: action, id: args[0], submissionId: Number(args[1]) }; break;
          default: throw new Error("Unknown command.");
        }
        const result = await client.command(command);
        if (action === "idle" && (result as { busy: boolean }).busy) throw new Error("The service has unfinished work; leave it running.");
        if (action === "download") {
          const value = result as { artifact: import("./artifacts.js").Artifact; dataBase64: string };
          await writeFile(args[2], Buffer.from(value.dataBase64, "base64"), { flag: "wx", mode: 0o600 });
          console.log(JSON.stringify({ ...value.artifact, path: args[2] }, null, 2));
        } else console.log(JSON.stringify(result, null, 2));
      }
    } finally { await client.close(); }
  }
} catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
