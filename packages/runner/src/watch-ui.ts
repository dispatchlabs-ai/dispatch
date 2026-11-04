import { Key, Markdown, ProcessTerminal, TuiAltScreen, matchesKey, truncateToWidth,
  stripTerminalSequences, visibleWidth, wrapTextWithAnsi, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
import { discoverWatchRuns, readWatchActivity, readWatchConversation, readWatchRun } from "./watch-reader.js";
import { terminalText } from "./terminal-output.js";
import type { WatchActivity, WatchConversation, WatchOptions, WatchPage, WatchRun, WatchSnapshot } from "./watch-types.js";

const ansi = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const bold = ansi(1), dim = ansi(2), accent = ansi(36), warning = ansi(33), failure = ansi(31);
const selected = (text: string) => ansi(7)(stripTerminalSequences(text));
const clean = (text: string) => terminalText(text).replace(/\t/g, "  ");
const oneLine = (text: string) => clean(text).replace(/\s+/g, " ").trim();
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(1, width));
const cell = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…", true);
const identity = (text: string) => text;
const markdownTheme: MarkdownTheme = { heading: bold, link: accent, linkUrl: dim, code: accent,
  codeBlock: identity, codeBlockBorder: dim, quote: dim, quoteBorder: dim, hr: dim, listBullet: accent,
  bold, italic: ansi(3), strikethrough: ansi(9), underline: ansi(4) };
const clock = (at?: number) => at ? new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
function age(at?: number): string {
  if (!at) return "—";
  const seconds = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return seconds < 60 ? `${seconds}s` : seconds < 3600 ? `${Math.floor(seconds / 60)}m` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
}
function label(activity: WatchActivity): string {
  const kind = activity.kind === "message" ? activity.role ?? "message" : activity.kind === "tool-call" ? "tool" : "result";
  return `${kind} · ${oneLine(activity.title)}`;
}
function listWindow<T>(items: T[], index: number, height: number): Array<{ item: T; index: number }> {
  const start = Math.max(0, Math.min(index - Math.floor(height / 2), items.length - height));
  return items.slice(start, start + height).map((item, i) => ({ item, index: start + i }));
}

/** A separate observer. Only the viewer's terminal and discovery child are owned here. */
export async function watchInTerminal(options: WatchOptions): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: false });
  const controller = new AbortController();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let closed = false;
  const close = () => { if (!closed) { closed = true; controller.abort(); finish(); } };

  class WatchView implements Component {
    view: "runs" | "agents" | "activity" | "conversation" | "detail" = "runs";
    runs: WatchRun[] = [];
    snapshots = new Map<string, WatchSnapshot>();
    run?: WatchRun;
    conversation?: WatchConversation;
    page?: WatchPage;
    detail?: WatchActivity;
    detailParent: "activity" | "conversation" = "conversation";
    detailOffset = 0;
    detailLength = 0;
    selection = { runs: 0, agents: 0, activity: 0, conversation: 0 };
    issues: string[] = [];
    error = "";
    busy = false;
    reading = false;
    following = true;
    autoOpen = true;
    observedAt?: number;
    navigation = 0;
    timer?: ReturnType<typeof setTimeout>;

    invalidate(): void {}
    get snapshot(): WatchSnapshot | undefined { return this.run && this.snapshots.get(this.run.key); }
    get conversations(): WatchConversation[] { return this.snapshot?.conversations ?? []; }
    get agentRows(): Array<{ key: string; title: string; status: string; activity: string;
      parentKey?: string; updatedAt?: number; conversation?: WatchConversation }> {
      return [
        ...this.conversations.map(c => ({ ...c, title: c.parentKey ? c.title : c.agent, conversation: c })),
        ...(this.run?.stores ?? []).filter(store => !this.conversations.some(c => c.agent === store.agent))
          .map(store => {
            const unavailable = !this.snapshot || this.snapshot.unavailableAgents.includes(store.agent);
            return { key: `${store.agent}:unassigned`, title: store.agent,
              status: unavailable ? "unavailable" : "idle",
              activity: unavailable ? "Could not observe agent state" : "No conversation assigned yet" };
          }),
      ];
    }
    get activity(): WatchActivity[] { return this.snapshot?.activity ?? []; }
    get entries(): WatchActivity[] { return this.page?.entries ?? []; }
    redraw(): void { if (!closed) tui.requestRender(); }
    async refresh(): Promise<void> {
      if (this.busy || closed) return;
      this.busy = true;
      const scope = this.run?.key;
      try {
        const discovery = await discoverWatchRuns({ ...options, signal: controller.signal,
          session: this.run?.session ?? options.session });
        if (closed || scope !== this.run?.key) return;
        this.issues = discovery.issues;
        const runKey = this.runs[this.selection.runs]?.key;
        this.runs = discovery.runs;
        const found = this.runs.findIndex(run => run.key === runKey);
        this.selection.runs = Math.max(0, found >= 0 ? found : Math.min(this.selection.runs, this.runs.length - 1));
        const summaries = await Promise.allSettled(this.runs.map(run => readWatchRun(run)));
        if (closed || scope !== this.run?.key) return;
        const selectedKey = this.agentRows[this.selection.agents]?.key;
        const activityKey = this.activity[this.selection.activity]?.id;
        for (const result of summaries) {
          if (result.status === "fulfilled") this.snapshots.set(result.value.run.key, result.value);
          else this.issues.push(result.reason instanceof Error ? result.reason.message : "Could not read session.");
        }
        if (this.run) {
          const next = this.runs.find(run => run.key === this.run!.key);
          if (next) this.run = next;
          else this.issues.push("Selected session is unavailable. Last observation retained.");
          const index = this.agentRows.findIndex(c => c.key === selectedKey);
          this.selection.agents = Math.max(0, index >= 0 ? index : Math.min(this.selection.agents, this.agentRows.length - 1));
          const activityIndex = this.activity.findIndex(entry => entry.id === activityKey);
          this.selection.activity = Math.max(0, activityIndex >= 0 ? activityIndex : this.activity.length - 1);
          if (this.conversation) this.conversation = this.conversations.find(c => c.key === this.conversation!.key) ?? this.conversation;
        }
        if (this.autoOpen && this.view === "runs" && this.runs.length === 1) {
          this.autoOpen = false; this.run = this.runs[0]; this.view = "agents";
        }
        this.error = "";
        if (this.view === "conversation" && this.following && this.run && this.conversation) await this.latest(false);
        if (this.view === "detail" && this.run && this.detail) {
          const id = this.detail.id, runKey = this.run.key;
          const entry = await readWatchActivity(this.run, this.detail);
          if (this.view === "detail" && this.run?.key === runKey && this.detail?.id === id) {
            if (entry) this.detail = entry;
            else this.error = "Selected event is unavailable. Last observation retained.";
          }
        }
        this.observedAt = Date.now();
      } catch (error) {
        if (!closed) this.error = error instanceof Error ? error.message : "Observation failed.";
      } finally {
        this.busy = false;
        this.redraw();
        if (!closed) this.timer = setTimeout(() => { void this.refresh(); }, 2000);
      }
    }
    async latest(jump = true): Promise<void> {
      if (!this.run || !this.conversation) return;
      if (jump) { this.navigation++; this.following = true; }
      if (this.reading) return;
      this.reading = true;
      const key = this.conversation.key, runKey = this.run.key, navigation = this.navigation;
      try {
        const page = await readWatchConversation(this.run, key);
        if (this.run?.key === runKey && this.conversation?.key === key && this.navigation === navigation && this.view === "conversation" && !closed) {
          this.page = page;
          this.selection.conversation = Math.max(0, page.entries.length - 1);
          this.following = true;
        }
      } catch (error) { this.error = error instanceof Error ? error.message : "Could not read conversation."; }
      finally { this.reading = false; this.redraw(); }
    }
    async earlier(): Promise<void> {
      if (!this.run || !this.conversation || !this.page?.hasEarlier || this.reading) return;
      this.reading = true;
      const key = this.conversation.key, runKey = this.run.key, navigation = this.navigation,
        anchor = this.entries[this.selection.conversation]?.id;
      try {
        const page = await readWatchConversation(this.run, key, this.page.before);
        if (this.run?.key === runKey && this.conversation?.key === key && this.navigation === navigation && this.view === "conversation" && !closed) {
          const current = new Set(this.entries.map(entry => entry.id));
          this.page = { ...page, entries: [...page.entries.filter(entry => !current.has(entry.id)), ...this.entries] };
          this.selection.conversation = Math.max(0, this.entries.findIndex(entry => entry.id === anchor));
          this.following = false;
        }
      } catch (error) { this.error = error instanceof Error ? error.message : "Could not load earlier history."; }
      finally { this.reading = false; this.redraw(); }
    }
    async open(): Promise<void> {
      this.navigation++;
      if (this.view === "runs") {
        const run = this.runs[this.selection.runs];
        if (run) { this.autoOpen = false; this.run = run; this.view = "agents"; this.selection.agents = 0; }
      } else if (this.view === "agents") {
        const conversation = this.agentRows[this.selection.agents]?.conversation;
        if (conversation) { this.conversation = conversation; this.page = undefined; this.following = true; this.view = "conversation"; await this.latest(); }
      } else if (this.view === "conversation" || this.view === "activity") {
        const activity = this.view === "conversation" ? this.entries[this.selection.conversation] : this.activity[this.selection.activity];
        if (activity) { this.detail = activity; this.detailParent = this.view; this.detailOffset = 0; this.view = "detail"; }
      }
      this.redraw();
    }
    back(): void {
      this.navigation++;
      if (this.view === "detail") this.view = this.detailParent;
      else if (this.view === "conversation") { this.view = "agents"; this.conversation = undefined; this.page = undefined; }
      else if (this.view === "activity") this.view = "agents";
      else if (this.view === "agents") {
        this.view = "runs"; this.run = undefined; this.autoOpen = false;
        if (this.timer) clearTimeout(this.timer);
        void this.refresh();
      }
      this.redraw();
    }
    move(delta: number): void {
      this.navigation++;
      if (this.view === "detail") this.detailOffset = Math.max(0, Math.min(this.detailLength - Math.max(1, terminal.rows - 7), this.detailOffset + delta));
      else {
        const items = this.view === "runs" ? this.runs : this.view === "agents" ? this.agentRows : this.view === "activity" ? this.activity : this.entries;
        const at = this.selection[this.view];
        if (this.view === "conversation") {
          this.following = false;
          if (at === 0 && delta < 0) { void this.earlier(); return; }
        }
        this.selection[this.view] = Math.max(0, Math.min(items.length - 1, at + delta));
      }
      this.redraw();
    }
    handleInput(data: string): void {
      if (data === "q" || matchesKey(data, Key.ctrl("c"))) { close(); return; }
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) this.back();
      else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) void this.open();
      else if (matchesKey(data, Key.up) || data === "k") this.move(-1);
      else if (matchesKey(data, Key.down) || data === "j") this.move(1);
      else if (matchesKey(data, Key.pageUp)) this.move(-Math.max(1, terminal.rows - 8));
      else if (matchesKey(data, Key.pageDown)) this.move(Math.max(1, terminal.rows - 8));
      else if (matchesKey(data, Key.tab) && (this.view === "agents" || this.view === "activity")) {
        this.view = this.view === "agents" ? "activity" : "agents"; this.redraw();
      } else if ((data === "f" || data === "G" || matchesKey(data, Key.end)) && this.view === "conversation") void this.latest();
      else if ((data === "g" || matchesKey(data, Key.home)) && this.view !== "detail") this.move(-Number.MAX_SAFE_INTEGER);
      else if (data === "r") {
        if (this.timer) clearTimeout(this.timer);
        void this.refresh();
      }
    }
    activityLine(entry: WatchActivity, width: number): string {
      return fit(`${clock(entry.at)}  ${entry.conversationKey}  ${label(entry)}`, width);
    }
    render(width: number): string[] {
      const height = Math.max(6, terminal.rows), bodyHeight = Math.max(1, height - 7);
      const title = this.run ? clean(this.run.session) : "Running sessions";
      const header = [bold(fit(`AGENT WATCH  /  ${title}`, width))];
      const snapshot = this.snapshot;
      if (this.run) {
        const active = this.conversations.filter(c => c.active > 0).length;
        const owner = this.run.pids.length ? accent("Owner observed") : warning("No process observed");
        header.push(fit(`${owner}  ·  ${this.conversations.length} conversations  ·  ${active} with unfinished tasks`, width));
      } else header.push(dim(fit(`${this.runs.length} running sessions  ·  read-only viewer`, width)));
      let subtitle = this.view === "runs" ? "Select a run to inspect" : this.view === "agents" ? "Agents" : this.view === "activity" ? "Recent activity" :
        this.view === "detail" ? label(this.detail!) : `${this.conversation?.key}  ·  ${this.following ? "Following latest" : "Reading saved history"}`;
      header.push(fit(`${subtitle}${this.busy || this.reading ? "  ·  refreshing" : ""}`, width), "");
      const body: string[] = [];
      if (this.view === "runs") {
        if (!this.runs.length) body.push(this.observedAt ? "No running sessions found. Waiting for a run…" : "Discovering running sessions…");
        for (const { item: run, index } of listWindow(this.runs, this.selection.runs, Math.max(1, Math.floor(bodyHeight / 2)))) {
          const summary = this.snapshots.get(run.key);
          const text = fit(`${index === this.selection.runs ? "›" : " "} ${clean(run.session)}`, width);
          body.push(index === this.selection.runs ? selected(text) : text);
          const latest = summary?.activity.at(-1);
          const activity = latest ? latest.kind === "tool-call" ? latest.text : latest.kind === "message" ? latest.text : `${latest.title} returned` : "No recorded activity";
          const starts = summary?.conversations.flatMap(c => c.startedAt ? [c.startedAt] : []) ?? [];
          body.push(dim(fit(`  ${summary?.conversations.length ?? "—"} conversations · age ${age(starts.length ? Math.min(...starts) : undefined)} · ${oneLine(activity)}`, width)));
        }
      } else if (this.view === "agents") {
        const nameWidth = Math.min(32, Math.max(16, Math.floor(width * 0.32)));
        const statusWidth = 11, timeWidth = 7;
        const columns = width >= 65;
        body.push(dim(columns ? `${cell("AGENT / CONVERSATION", nameWidth)} ${cell("TASK STATE", statusWidth)} ${cell("LAST", timeWidth)} ACTIVITY` : "AGENT / TASK STATE / ACTIVITY"));
        const available = Math.max(1, bodyHeight - 1);
        if (!this.agentRows.length) body.push("No conversations recorded yet.");
        for (const { item: c, index } of listWindow(this.agentRows, this.selection.agents, available)) {
          const name = `${index === this.selection.agents ? "›" : " "} ${c.parentKey ? "↳ " : ""}${oneLine(c.title || c.key)}`;
          const state = c.status;
          const row = columns ? `${cell(name, nameWidth)} ${cell(state, statusWidth)} ${cell(age(c.updatedAt), timeWidth)} ${oneLine(c.activity)}` : `${name} · ${state} · ${oneLine(c.activity)}`;
          const text = fit(row, width);
          body.push(index === this.selection.agents ? selected(text) : text);
        }
      } else if (this.view === "activity" || this.view === "conversation") {
        const entries = this.view === "activity" ? this.activity : this.entries;
        const index = this.selection[this.view];
        if (!entries.length) body.push(this.reading ? "Reading conversation…" : "No public messages or tool activity recorded yet.");
        for (const row of listWindow(entries, index, Math.max(1, Math.floor(bodyHeight / 2)))) {
          const summary = this.view === "activity" ? this.activityLine(row.item, width - 2) : `${clock(row.item.at)}  ${label(row.item)}`;
          const text = fit(`${row.index === index ? "›" : " "} ${summary}`, width);
          body.push(row.index === index ? selected(text) : row.item.error ? failure(text) : text);
          body.push(dim(fit(`  ${oneLine(row.item.text) || (row.item.result ? "Result available · Enter to inspect" : row.item.kind === "tool-call" ? "Enter for arguments and matching result" : "")}`, width)));
        }
      } else if (this.detail) {
        const entry = this.detail;
        const sections: string[] = [`${entry.conversationKey} · ${clock(entry.at)}`, ""];
        if (entry.kind === "tool-call") {
          sections.push("Arguments", "", JSON.stringify(entry.arguments ?? {}, null, 2), "", "Matching result", "",
            entry.result ? `${entry.result.error ? "Tool reported an error" : "Returned"} · ${clock(entry.result.at)}\n\n${entry.result.text}` : "No matching result recorded in this observation.");
        } else sections.push(entry.text);
        const text = clean(sections.join("\n"));
        const lines = entry.kind === "message" ? new Markdown(text, 0, 0, markdownTheme, undefined, { renderLatex: false }).render(width) : wrapTextWithAnsi(text, Math.max(1, width));
        this.detailLength = lines.length;
        this.detailOffset = Math.max(0, Math.min(this.detailOffset, lines.length - bodyHeight));
        body.push(...lines.slice(this.detailOffset, this.detailOffset + bodyHeight));
      }
      const issues = [this.error, ...this.issues, ...(snapshot?.issues ?? [])].filter(Boolean);
      const observation = issues.length ? warning(oneLine(issues[0])) : dim(`Observed ${clock(this.observedAt)} · viewer exit leaves agents running`);
      const hints = this.view === "detail" ? "↑↓ / PgUp PgDn Scroll  Esc Back  q Quit viewer" : this.view === "conversation" ?
        "↑↓ Select  Enter Expand  PgUp Earlier  f Follow latest  Esc Back  q Quit" : this.view === "runs" ?
          "↑↓ Select  Enter Open  r Refresh  q Quit viewer" : "↑↓ Select  Enter Inspect  Tab Agents/activity  Esc Sessions  q Quit";
      const lines = [...header, ...body.slice(0, bodyHeight)];
      while (lines.length < height - 3) lines.push("");
      lines.push("", fit(observation, width), dim(fit(hints, width)));
      return lines.slice(0, height).map(line => visibleWidth(line) > width ? fit(line, width) : line);
    }
  }
  const view = new WatchView();
  const terminate = () => close();
  process.once("SIGINT", terminate);
  process.once("SIGTERM", terminate);
  try {
    tui.addChild(view);
    tui.setFocus(view);
    tui.start();
    void view.refresh();
    await done;
  } finally {
    closed = true;
    controller.abort();
    if (view.timer) clearTimeout(view.timer);
    process.removeListener("SIGINT", terminate);
    process.removeListener("SIGTERM", terminate);
    tui.stop({ preserveScreen: true });
    await terminal.drainInput();
    process.stdin.pause();
  }
}
