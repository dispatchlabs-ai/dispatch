import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { connectClient, type ClientConnection, type AgentClient, type ChatWatch } from "./client.js";
import type { ChatSnapshot } from "./chat.js";
import type { AttachmentFile } from "./chat-content.js";
import { terminalText } from "./terminal-output.js";
import { chatInTerminal } from "./chat-terminal.js";

export type ServiceTerminalOptions = {
  client?: AgentClient;
  socket?: string;
  connection?: ClientConnection;
  id?: string;
  agent?: string;
  /** Only used for a new key; retained sessions keep their original agent. */
  defaultAgent?: string;
  session?: string;
  prompt?: string;
  history?: boolean;
  requestId?: string;
  files?: AttachmentFile[];
  drain?: boolean;
  /** Local ordinary owner artifact root; never inferred for opaque facades. */
  artifactDirectory?: string;
  expected?: import("./service.js").ServiceExpectation;
};

/** A terminal connection is not an execution owner. Disconnect never sends Stop. */
export async function connectInTerminal(options: ServiceTerminalOptions) {
  if (options.prompt === undefined && !options.history && !options.files?.length
    && process.stdin.isTTY && process.stdout.isTTY && process.env.TERM !== "dumb") {
    return chatInTerminal(options);
  }
  const controller = new AbortController();
  let input: ReturnType<typeof createInterface> | undefined;
  let client: AgentClient | undefined;
  let watch: ChatWatch | undefined;
  let interrupted = false;
  const interrupt = () => { interrupted = true; controller.abort(); input?.close(); process.exitCode = 130; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    if (!options.client && !options.connection && !options.socket) throw new Error("Configure a service connection.");
    client = options.client ?? await connectClient({ ...(options.connection ?? { socket: options.socket! }), expected: options.expected });
    const connected = client;
    const info = await connected.info();
    const call = <C extends import("./protocol.js").ServiceCommand>(command: C) => connected.command(command, controller.signal);
    let id = options.id;
    if (!id) {
      const session = options.session ?? randomUUID();
      const key = `terminal:${session}`;
      const saved = await call({ method: "find", key, agent: options.agent });
      if (saved && (!options.agent || saved.agent === options.agent)) id = saved.id;
      else {
        if (options.history) throw new Error("No retained conversation matches this session. History never creates one.");
        const agent = options.agent ?? options.defaultAgent ?? info.defaultAgent;
        if (!agent) throw new Error("Choose an agent for a new session.");
        id = (await call({ method: "create", agent, key, source: "cli" })).id;
      }
      process.stderr.write(terminalText(`Session: ${session}\n`));
    }
    let chatId = id;
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
      if (value.chat.id !== chatId) return;
      for (const message of value.messages) {
        if (seen.has(message.id)) continue;
        seen.add(message.id);
        if (message.role !== "assistant") continue;
        process.stdout.write(terminalText(message.text.startsWith(partial) ? message.text.slice(partial.length) : `\n${message.text}`));
        process.stdout.write("\n");
        for (const file of message.artifacts ?? []) {
          process.stdout.write(terminalText(`Attachment: ${file.name} (${file.id})\n`));
          if (options.artifactDirectory) process.stdout.write(terminalText(
            `${join(options.artifactDirectory, String(value.chat.conversationId), "files", file.id)}\n`));
        }
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
      return call({ method: "send", id: chatId, text, requestId, files, mode: "steer", source: "cli" });
    };
    let observationError: unknown;
    const observe = async () => {
      await watch?.stop();
      watch = await connected.watch(chatId, render, controller.signal);
      void watch.closed.catch(error => { if (!controller.signal.aborted) { observationError = error; input?.close(); } });
    };
    if (options.prompt !== undefined || options.files?.length) {
      const { submissionId } = await send(options.prompt ?? "", options.requestId, options.files);
      process.stderr.write(`Submission: ${submissionId}\n`);
      // A retry can reattach to an already completed submission. Its native
      // answer was in the initial snapshot, but is still owed to this invocation.
      const initialReceipt = await call({ method: "receipt", id: chatId, submissionId });
      if (initialReceipt.status === "done" && initialReceipt.type === "input") {
        for (const id of seen) if (id.startsWith(`${initialReceipt.answer}:`)) seen.delete(id);
      }
      await observe();
      const receipt = await connected.wait(chatId, submissionId, controller.signal);
      render(await snapshot());
      if (receipt.status !== "done") throw new Error(`Turn did not complete: ${receipt.reason}. Inspect the receipt and history.`);
      if (options.drain) await call({ method: "drain" });
      if (observationError) throw observationError;
      return;
    }
    input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    input.on("SIGINT", interrupt);
    process.stderr.write("Commands: /new, /history, /stop, /quit. Messages steer active work at its next native boundary.\n");
    await observe();
    try {
      for await (const line of input) {
        const text = line.trim();
        if (text === "/quit") break;
        if (text === "/new") {
          const agent = options.agent ?? (await snapshot()).chat.agent;
          chatId = (await call({ method: "create", agent, key: `terminal:${randomUUID()}`, source: "cli" })).id;
          seen.clear(); partial = ""; tools = "";
          await observe();
          process.stderr.write(terminalText(`Conversation: ${chatId}\n`));
        } else if (text === "/history") await history();
        else if (text === "/stop") await call({ method: "stop", id: chatId });
        else if (text) {
          const receipt = await send(text);
          process.stderr.write(`Submission: ${receipt.submissionId}\n`);
        }
      }
    } finally { await watch?.stop(); }
    if (observationError) throw observationError;
  } catch (error) { if (!interrupted) throw error; }
  finally {
    await watch?.stop();
    await client?.close();
    input?.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
  }
}
