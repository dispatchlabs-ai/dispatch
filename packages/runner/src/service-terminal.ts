import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { serviceRequest } from "./service.js";
import type { ChatSnapshot } from "./chat.js";
import type { AttachmentFile } from "./chat-content.js";
import { terminalText } from "./terminal-output.js";

export type ServiceTerminalOptions = {
  socket: string;
  id?: string;
  agent?: string;
  /** Only used for a new key; retained sessions keep their original agent. */
  defaultAgent?: string;
  session?: string;
  prompt?: string;
  history?: boolean;
  requestId?: string;
  files?: AttachmentFile[];
};

/** A terminal connection is not an execution owner. Disconnect never sends Stop. */
export async function connectInTerminal(options: ServiceTerminalOptions) {
  const controller = new AbortController();
  let input: ReturnType<typeof createInterface> | undefined;
  let interrupted = false;
  const interrupt = () => { interrupted = true; controller.abort(); input?.close(); process.exitCode = 130; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const call = <C extends import("./service.js").ServiceCommand>(command: C) =>
      serviceRequest(options.socket, command, { signal: controller.signal });
    let id = options.id;
    if (!id) {
      const session = options.session ?? randomUUID();
      const key = `terminal:${session}`;
      const saved = await call({ method: "find", key, agent: options.agent });
      if (saved && (!options.agent || saved.agent === options.agent)) id = saved.id;
      else {
        const agent = options.agent ?? options.defaultAgent;
        if (!agent) throw new Error("Choose an agent for a new session.");
        id = (await call({ method: "create", agent, key, source: "cli" })).id;
      }
      process.stderr.write(terminalText(`Session: ${session}\n`));
    }
    const chatId = id;
    process.stderr.write(terminalText(`Conversation: ${chatId}\nDisconnect leaves work running. Use /stop to cancel.\n`));
    const snapshot = () => call({ method: "snapshot", id: chatId });
    const history = async () => {
      for (const message of (await snapshot()).messages) {
        process.stdout.write(terminalText(`${message.author ?? message.role}: ${message.text}${message.error ? `\nError: ${message.error}` : ""}\n`));
        for (const file of [...message.attachments ?? [], ...message.artifacts ?? []])
          process.stdout.write(terminalText(`Attachment: ${file.name}\n`));
      }
    };
    if (options.history) { await history(); return; }
    const seen = new Set((await snapshot()).messages.map(message => message.id));
    let partial = "", tools = "";
    const render = (value: ChatSnapshot) => {
      for (const message of value.messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        if (message.role !== "assistant") continue;
        process.stdout.write(terminalText(message.text.startsWith(partial) ? message.text.slice(partial.length) : `\n${message.text}`));
        process.stdout.write("\n");
        for (const file of message.artifacts ?? []) process.stdout.write(terminalText(`Attachment: ${file.name} (${file.id})\n`));
        if (message.error) process.stderr.write(terminalText(`${message.error}\n`));
        partial = "";
      }
      if (value.partial && value.partial !== partial) {
        process.stdout.write(terminalText(value.partial.startsWith(partial) ? value.partial.slice(partial.length) : `\n${value.partial}`));
        partial = value.partial;
      }
      const next = value.tools.join(", ");
      if (next && next !== tools) process.stderr.write(terminalText(`[${next}]\n`));
      tools = next;
    };
    const send = async (text: string, requestId: string = randomUUID(), files: AttachmentFile[] = []) => {
      // Print before admission so an uncertain transport can be retried explicitly.
      process.stderr.write(terminalText(`Request: ${requestId}\n`));
      return call({ method: "send", id: chatId, text, requestId, files, source: "cli" });
    };
    if (options.prompt !== undefined || options.files?.length) {
      const { submissionId } = await send(options.prompt ?? "", options.requestId, options.files);
      process.stderr.write(`Submission: ${submissionId}\n`);
      while (!controller.signal.aborted) {
        render(await snapshot());
        const receipt = await call({ method: "receipt", id: chatId, submissionId });
        if (receipt.status === "done" || receipt.status === "unanswered") {
          render(await snapshot());
          if (receipt.status !== "done") throw new Error(`Turn did not complete: ${receipt.reason}. Inspect the receipt and history.`);
          return;
        }
        await delay(200, undefined, { signal: controller.signal });
      }
      return;
    }
    input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    input.on("SIGINT", interrupt);
    process.stderr.write("Commands: /history, /stop, /quit. Messages queue without waiting for a reply.\n");
    let observationError: unknown;
    const observing = (async () => {
      while (!controller.signal.aborted) {
        render(await snapshot());
        await delay(200, undefined, { signal: controller.signal });
      }
    })().catch(error => { if (!controller.signal.aborted) { observationError = error; input?.close(); } });
    try {
      for await (const line of input) {
        const text = line.trim();
        if (text === "/quit") break;
        if (text === "/history") await history();
        else if (text === "/stop") await call({ method: "stop", id: chatId });
        else if (text) {
          const receipt = await send(text);
          process.stderr.write(`Submission: ${receipt.submissionId}\n`);
        }
      }
    } finally { controller.abort(); await observing; }
    if (observationError) throw observationError;
  } catch (error) { if (!interrupted) throw error; }
  finally {
    input?.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
