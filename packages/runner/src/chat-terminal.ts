import { randomUUID } from "node:crypto";
import { connectClient, ServiceError, type AgentClient, type ServiceCommand, type ServiceExpectation } from "./client.js";
import { ChatUI, type ChatUIState } from "./chat-ui.js";
import type { ServiceTerminalOptions } from "./service-terminal.js";
import { terminalText } from "./terminal-output.js";

type PendingSend = { id: string; chatId: string; text: string; uncertain: boolean; sending: boolean };

/** Pi owns the terminal. The connected host remains the only conversation owner. */
export async function chatInTerminal(options: ServiceTerminalOptions): Promise<void> {
  const connection = options.connection ?? (options.socket ? { socket: options.socket } : undefined);
  if (!options.client && !connection) throw new Error("Configure a service connection.");
  const lifetime = new AbortController();
  let client: AgentClient | undefined = options.client;
  let observation: AbortController | undefined;
  let connecting: AbortController | undefined;
  let navigation = 0;
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const pending = new Map<string, PendingSend>();
  const sends = new Set<Promise<void>>();
  const drafts = new Map<string, string>();
  const sessionKey = `terminal:${options.session ?? randomUUID()}`;
  let chatId: string | undefined;
  let expected: ServiceExpectation | undefined = options.expected;
  const state: ChatUIState = { agents: [], connection: "connecting" };
  const quit = () => { lifetime.abort(); observation?.abort(); connecting?.abort(); finish(); };
  const ui = new ChatUI(text => { void handle(text); }, quit);
  const current = (ticket: number) => !lifetime.signal.aborted && ticket === navigation;
  const call = <C extends ServiceCommand>(command: C) => {
    if (!client) throw new Error("No host connection. Use /reconnect.");
    return client.command(command, lifetime.signal);
  };
  const render = () => {
    if (lifetime.signal.aborted) return;
    const active = [...pending.values()].filter(item => item.chatId === chatId);
    state.pending = active.some(item => item.uncertain)
      ? "Delivery unknown · /retry reuses the same request"
      : active.length ? "Sending…" : undefined;
    ui.update(state);
  };
  const notice = (message: string) => { state.notice = message; render(); };
  const describe = (error: unknown) => error instanceof Error ? error.message : String(error);
  const disconnected = (error: unknown) => {
    state.connection = "disconnected";
    notice(connection?.socket && ["ENOENT", "ECONNREFUSED"].includes((error as NodeJS.ErrnoException)?.code ?? "")
      ? "No host listening · start your host, then /reconnect."
      : `Disconnected · /reconnect. ${describe(error)}`);
  };

  async function observe(id: string, top = false): Promise<void> {
    observation?.abort();
    const controller = observation = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, controller.signal]);
    state.connection = "connecting";
    render();
    try {
      if (!client) throw new Error("No host connection.");
      const watch = await client.watch(id, snapshot => {
        if (signal.aborted) return;
        state.snapshot = snapshot;
        state.connection = "connected";
        render();
      }, signal);
      if (signal.aborted) { await watch.stop(); return; }
      if (top) ui.showHistory();
      void watch.closed.then(
        () => { if (!signal.aborted) disconnected("The host stream ended."); },
        error => { if (!signal.aborted) disconnected(error); },
      );
    } catch (error) { if (!signal.aborted) disconnected(error); }
  }

  async function select(id: string): Promise<void> {
    if (chatId !== id) {
      const initialDraft = chatId ? "" : ui.getDraft();
      if (chatId) drafts.set(chatId, ui.getDraft());
      chatId = id;
      state.snapshot = undefined;
      ui.setDraft(drafts.get(id) ?? initialDraft);
    }
    state.notice = undefined;
    await observe(id);
  }

  async function openAgent(agent: string, ticket: number): Promise<void> {
    if (!state.agents.some(entry => entry.id === agent)) throw new Error(`Agent not served: ${agent}`);
    const saved = await call({ method: "find", agent, key: sessionKey });
    if (!current(ticket)) return;
    const chat = saved ?? await call({ method: "create", agent, source: "cli", key: sessionKey });
    if (current(ticket)) await select(chat.id);
  }

  function chooseAgent(): void {
    ui.showPicker("Choose an agent", state.agents.map(agent => ({
      value: agent.id, label: agent.id, description: agent.description,
    })), agent => {
      const ticket = ++navigation;
      void openAgent(agent, ticket).catch(error => { if (current(ticket)) notice(describe(error)); });
    });
  }

  function restoreDraft(id: string, text: string): void {
    const previous = id === chatId ? ui.getDraft() : drafts.get(id);
    const restored = [text, previous].filter(Boolean).join("\n\n");
    if (id === chatId) ui.setDraft(restored);
    else drafts.set(id, restored);
  }

  function send(item: PendingSend): void {
    if (item.sending || lifetime.signal.aborted) return;
    item.sending = true;
    pending.set(item.id, item);
    state.notice = undefined;
    render();
    const sending = (async () => {
      try {
        await call({ method: "send", id: item.chatId, text: item.text, requestId: item.id, mode: "steer", source: "cli" });
        pending.delete(item.id);
      } catch (error) {
        // A definite rejection now does not disprove admission by an earlier attempt.
        const rejected = error instanceof ServiceError && [400, 401, 403, 404, 409, 415].includes(error.status);
        if (rejected && !item.uncertain) {
          pending.delete(item.id);
          restoreDraft(item.chatId, item.text);
          notice(`Message rejected · draft restored in ${item.chatId}. ${describe(error)}`);
        } else {
          item.uncertain = true;
          notice(`Delivery unknown · /retry. ${describe(error)}`);
        }
      } finally { item.sending = false; render(); }
    })();
    sends.add(sending);
    void sending.finally(() => sends.delete(sending));
  }

  async function reconnect(): Promise<void> {
    const ticket = ++navigation;
    connecting?.abort();
    const attempt = connecting = new AbortController();
    const signal = AbortSignal.any([lifetime.signal, attempt.signal]);
    observation?.abort();
    state.connection = "connecting";
    state.notice = undefined;
    render();
    try {
      if (connection) {
        const replacement = await connectClient({ ...connection, expected }, signal);
        if (!current(ticket)) { await replacement.close(); return; }
        const previous = client;
        client = replacement;
        await previous?.close();
      }
      const info = await call({ method: "info" });
      expected ??= info.identity !== undefined ? { identity: info.identity }
        : info.stateRoot !== undefined ? { stateRoot: info.stateRoot } : undefined;
      const agents = await call({ method: "agents" });
      if (!current(ticket)) return;
      state.agents = agents;
      if (!agents.length) throw new Error("The host has no agents.");
      if (chatId || options.id) await select(chatId ?? options.id!);
      else {
        // A retained session keeps its original agent when a host default changes.
        const retained = (await Promise.all(agents.filter(agent => !options.agent || agent.id === options.agent)
          .map(agent => call({ method: "find", agent: agent.id, key: sessionKey })))).filter(chat => chat !== null);
        if (!current(ticket)) return;
        if (retained.length === 1) await select(retained[0].id);
        else if (retained.length > 1) { state.connection = "connected"; render(); chooseAgent(); }
        else {
          const agent = options.agent ?? options.defaultAgent ?? info.defaultAgent
            ?? (agents.length === 1 ? agents[0].id : undefined);
          if (agent) await openAgent(agent, ticket);
          else { state.connection = "connected"; render(); chooseAgent(); }
        }
      }
    } catch (error) { if (current(ticket)) disconnected(error); }
  }

  async function handle(text: string): Promise<void> {
    if (lifetime.signal.aborted || !text.trim()) return;
    const command = text.trim();
    const selected = chatId;
    let ticket = navigation;
    try {
      if (command === "/quit") { quit(); return; }
      if (command === "/help") { ui.showHelp(); return; }
      if (command === "/reconnect") { await reconnect(); return; }
      if (!client || state.connection === "connecting") {
        if (!command.startsWith("/")) ui.setDraft(text);
        notice("Waiting for a host connection · /reconnect to try again.");
        return;
      }
      if (command === "/agents") {
        ticket = ++navigation;
        const agents = await call({ method: "agents" });
        if (current(ticket)) { state.agents = agents; chooseAgent(); }
      } else if (command === "/chats") {
        ticket = ++navigation;
        const chats = await call({ method: "chats" });
        if (current(ticket)) ui.showPicker("Choose a conversation", chats.map(chat => ({
          value: chat.id, label: chat.title, description: `${chat.agent} · ${chat.id}`,
        })), id => { ++navigation; void select(id); });
      } else if (command === "/new") {
        ticket = ++navigation;
        const agent = state.snapshot?.chat.agent;
        if (!agent) chooseAgent();
        else {
          const chat = await call({ method: "create", agent, source: "cli", key: `terminal:${randomUUID()}` });
          if (current(ticket)) await select(chat.id);
        }
      } else if (command === "/retry") {
        const uncertain = [...pending.values()].filter(item => item.uncertain && !item.sending);
        if (!uncertain.length) notice("No uncertain messages to retry.");
        else ui.showPicker("Retry the same request", uncertain.map(item => ({
          value: item.id, label: item.text, description: `${item.chatId} · ${item.id}`,
        })), id => { const item = pending.get(id); if (item) send(item); });
      } else if (command === "/stop") {
        if (selected) {
          await call({ method: "stop", id: selected });
          if (selected === chatId) notice("Stop requested.");
        } else notice("Choose a conversation first · /chats or /agents.");
      } else if (command === "/history") {
        ticket = ++navigation;
        if (selected) await observe(selected, true);
      } else if (command.startsWith("/")) {
        ui.setDraft(text);
        notice("Unknown command · /help lists commands.");
      } else if (state.connection !== "connected" || !state.snapshot || !selected) {
        ui.setDraft(text);
        notice("Draft kept · /reconnect, /chats or /agents to continue.");
      } else send({ id: randomUUID(), chatId: selected, text, uncertain: false, sending: false });
    } catch (error) { if (current(ticket)) notice(describe(error)); }
  }

  process.on("SIGINT", quit);
  process.on("SIGTERM", quit);
  process.on("SIGHUP", quit);
  process.stdin.on("end", quit);
  try {
    ui.start();
    render();
    void reconnect();
    await done;
  } finally {
    quit();
    ui.stop();
    await client?.close();
    await Promise.all(sends);
    process.removeListener("SIGINT", quit);
    process.removeListener("SIGTERM", quit);
    process.removeListener("SIGHUP", quit);
    process.stdin.removeListener("end", quit);
    for (const item of pending.values()) process.stderr.write(terminalText(
      `Delivery unknown for ${item.chatId}. Request: ${item.id}\n${item.text}\nInspect history before retrying the same payload with --request-id.\n`));
  }
}
