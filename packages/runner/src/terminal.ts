import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import { context, type Chat, type ChatService } from "./chat.js";
import { run, type RunOptions } from "./run.js";
import { terminalError, terminalText } from "./terminal-output.js";

export type TerminalOptions = RunOptions & {
  agent: string;
  session?: string;
  prompt?: string;
  newChat?: boolean;
  history?: boolean;
  /** Keep a continuous agent working in this named conversation until paused or interrupted. */
  continuous?: boolean;
};

async function showHistory(service: ChatService, chat: Chat) {
  const { host, conversation } = await service.resolve(chat.id);
  for (const message of (await service.snapshot(chat.id)).messages) {
    console.log(terminalText(`${message.role}: ${message.text}${message.error ? `\nError: ${message.error}` : ""}\n`));
    for (const file of message.artifacts ?? []) console.log(terminalText(
      `Attachment: ${file.name} (${file.size} bytes)\n${host.artifacts.directory}/${conversation.id}/files/${file.id}`));
  }
}

/** A local terminal is another client of the same durable conversation service. */
export async function chatInTerminal(options: TerminalOptions): Promise<void> {
  if (options.continuous && options.history) throw new Error("Choose continuous work or history.");
  const app = await run({ ...options, names: options.names ?? [options.agent], resume: false })
    .catch((error: unknown) => { throw terminalError(error); });
  const controller = new AbortController();
  let input: ReturnType<typeof createInterface> | undefined;
  const interrupt = () => { controller.abort(); input?.close(); process.exitCode = 130; };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  try {
    const key = options.newChat ? randomUUID() : options.session ?? "main";
    let chat = await app.service.create(options.agent, "cli", `terminal:${key}`);
    const diagnostics = process.stderr;
    diagnostics.write(terminalText(`Conversation: ${chat.id} (session: ${key})${options.demo ? " [scripted demo]" : ""}\n`));
    if (options.history) { await showHistory(app.service, chat); return; }
    if (!options.continuous) {
      const host = app.service.host(chat.agent);
      const saved = await host.state();
      const task = saved.loopId ? await host.harness.getTask(saved.loopId as import("@earendil-works/pi-durable").TaskId, context) : undefined;
      if (task && task.state.status !== "terminal") throw new Error("A saved loop is still active. Resume in continuous mode instead of starting a separate terminal turn.");
      for (const sibling of app.service.hosts.values()) sibling.harness.resume();
    }

    const observe = async (action: () => Promise<void>) => {
      controller.signal.throwIfAborted();
      const previous = new Set((await app.service.snapshot(chat.id)).messages.map(message => message.id));
      let partial = "";
      let lastTools = "";
      const watch = await app.service.watch(chat.id, async snapshot => {
        for (const message of snapshot.messages) {
          if (previous.has(message.id)) continue;
          previous.add(message.id);
          if (message.role !== "assistant") continue;
          process.stdout.write(terminalText(message.text.startsWith(partial) ? message.text.slice(partial.length) : `\n${message.text}`));
          process.stdout.write("\n");
          for (const file of message.artifacts ?? []) {
            const { host, conversation } = await app.service.resolve(chat.id);
            // Direct terminal mode runs as the local owner. Print the retained
            // file, never the temporary source workspace path.
            process.stdout.write(terminalText(`Attachment: ${file.name}\n${host.artifacts.directory}/${conversation.id}/files/${file.id}\n`));
          }
          partial = "";
          // Native submission/loop outcomes determine failure after retries settle.
          if (message.error) diagnostics.write(terminalText(`${message.error}\n`));
        }
        if (snapshot.partial && snapshot.partial !== partial) {
          process.stdout.write(terminalText(snapshot.partial.startsWith(partial) ? snapshot.partial.slice(partial.length) : `\n${snapshot.partial}`));
          partial = snapshot.partial;
        }
        const tools = snapshot.tools.join(", ");
        if (tools && tools !== lastTools) diagnostics.write(terminalText(`[${tools}]\n`));
        lastTools = tools;
      });
      let cancel!: () => void;
      const interrupted = new Promise<never>((_, reject) => {
        cancel = () => reject(controller.signal.reason);
        controller.signal.addEventListener("abort", cancel, { once: true });
      });
      try {
        controller.signal.throwIfAborted();
        await Promise.race([action(), interrupted]);
      } finally {
        controller.signal.removeEventListener("abort", cancel);
        await watch.stop();
      }
    };

    const submit = (text: string) => observe(async () => {
      const { submissionId } = await app.service.submit(chat.id, text, randomUUID(), "followUp", "cli");
      const submission = await app.service.host(chat.agent).harness.submission(submissionId, context);
      if (!submission) throw new Error("Submitted turn is missing.");
      const receipt = await submission.wait(context);
      if (receipt.status !== "done") throw new Error(`Turn did not complete: ${receipt.reason}. Use --history for details.`);
    });

    if (options.continuous) {
      diagnostics.write("Continuous work. Each completed pass starts the next. Ctrl-C saves and suspends the loop.\n");
      await observe(async () => {
        const { host, conversation } = await app.service.resolve(chat.id);
        const loop = await host.start(false, { conversationId: conversation.id, input: options.prompt });
        const state = await host.wait(loop);
        if (state.phase === "paused") diagnostics.write(terminalText(`Paused: ${state.pauseReason}\n`));
      });
      return;
    }

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
        diagnostics.write(terminalText(`Conversation: ${chat.id}; resume with --session ${session}\n`));
      } else if (text) await submit(text);
      if (controller.signal.aborted) break;
      prompt();
    }
  } catch (error) {
    if (!controller.signal.aborted) throw terminalError(error);
  } finally {
    input?.close();
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await app.close().catch((error: unknown) => { throw terminalError(error); });
  }
}
