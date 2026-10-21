import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { context, type Chat, type ChatService } from "./chat.js";
import { run, type RunOptions } from "./run.js";

export type TerminalOptions = RunOptions & {
  agent: string;
  session?: string;
  prompt?: string;
  newChat?: boolean;
  history?: boolean;
};

async function showHistory(service: ChatService, chat: Chat) {
  for (const message of (await service.snapshot(chat.id)).messages) {
    console.log(`${message.role}: ${message.text}${message.error ? `\nError: ${message.error}` : ""}\n`);
  }
}

/** A local terminal is another client of the same durable conversation service. */
export async function chatInTerminal(options: TerminalOptions): Promise<void> {
  const app = await run({ ...options, names: [options.agent], resume: !options.history });
  const controller = new AbortController();
  let input: ReturnType<typeof createInterface> | undefined;
  const interrupt = () => { controller.abort(); input?.close(); process.exitCode = 130; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const key = options.newChat ? randomUUID() : options.session ?? "main";
    let chat = await app.service.create(options.agent, "cli", `terminal:${key}`);
    const diagnostics = process.stderr;
    diagnostics.write(`Conversation: ${chat.id} (session: ${key})${options.demo ? " [scripted demo]" : ""}\n`);
    if (options.history) { await showHistory(app.service, chat); return; }

    const submit = async (text: string) => {
      controller.signal.throwIfAborted();
      const previous = new Set((await app.service.snapshot(chat.id)).messages.map(message => message.id));
      let partial = "";
      let lastTools = "";
      let generationError: string | undefined;
      const watch = await app.service.watch(chat.id, async snapshot => {
        for (const message of snapshot.messages) {
          if (previous.has(message.id)) continue;
          previous.add(message.id);
          if (message.role !== "assistant") continue;
          process.stdout.write(message.text.startsWith(partial) ? message.text.slice(partial.length) : `\n${message.text}`);
          process.stdout.write("\n");
          partial = "";
          if (message.error) generationError = message.error;
        }
        if (snapshot.partial && snapshot.partial !== partial) {
          process.stdout.write(snapshot.partial.startsWith(partial) ? snapshot.partial.slice(partial.length) : `\n${snapshot.partial}`);
          partial = snapshot.partial;
        }
        const tools = snapshot.tools.join(", ");
        if (tools && tools !== lastTools) diagnostics.write(`[${tools}]\n`);
        lastTools = tools;
      });
      let cancel!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        cancel = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        controller.signal.throwIfAborted();
        const answer = async () => {
          const { submissionId } = await app.service.submit(chat.id, text, randomUUID(), "followUp", "cli");
          const submission = await app.service.host(chat.agent).harness.submission(submissionId, context);
          if (!submission) throw new Error("Submitted turn is missing.");
          return submission.wait(context);
        };
        const receipt = await Promise.race([answer(), interrupted]);
        if (receipt.status !== "done") throw new Error(`Turn did not complete: ${receipt.reason}`);
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        await watch.stop();
      }
      if (generationError) throw new Error(generationError);
    };

    if (options.prompt !== undefined) { await submit(options.prompt); return; }
    diagnostics.write("Commands: /new, /history, /quit. Ctrl-C saves and suspends unfinished work.\n");
    input = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });
    input.on("SIGINT", interrupt);
    const prompt = () => { if (process.stdin.isTTY) { input!.setPrompt("you> "); input!.prompt(); } };
    prompt();
    for await (const line of input) {
      const text = line.trim();
      if (text === "/quit") break;
      if (text === "/history") await showHistory(app.service, chat);
      else if (text === "/new") {
        const session = randomUUID();
        chat = await app.service.create(options.agent, "cli", `terminal:${session}`);
        diagnostics.write(`Conversation: ${chat.id}; resume with --session ${session}\n`);
      } else if (text) await submit(text);
      if (controller.signal.aborted) break;
      prompt();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally {
    input?.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await app.close();
  }
}
