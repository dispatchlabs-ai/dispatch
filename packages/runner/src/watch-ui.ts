import { HStack, Input, Key, Markdown, ProcessTerminal, ScrollView, TuiAltScreen, VStack,
  matchesKey, stripTerminalSequences, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type Component, type MarkdownTheme, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { discoverWatchRuns, readWatchActivity, readWatchConversation, readWatchRun } from "./watch-reader.js";
import { actionTitle, age, clean, clock, feedRows, humanName, oneLine, pairedActivity, toolState,
  type FeedFilter, type FeedRow } from "./watch-presentation.js";
import type { WatchActivity, WatchConversation, WatchOptions, WatchPage, WatchRun, WatchSnapshot } from "./watch-types.js";

const ansi = (code: string | number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const bold = ansi(1), accent = ansi(36), muted = ansi(90), warning = ansi(33), failure = ansi(31), success = ansi(32);
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…");
const pad = (text: string, width: number) => fit(text, width) + " ".repeat(Math.max(0, width - visibleWidth(text)));
const identity = (text: string) => text;
const markdownTheme: MarkdownTheme = { heading: bold, link: accent, linkUrl: muted, code: accent,
  codeBlock: identity, codeBlockBorder: muted, quote: identity, quoteBorder: muted, hr: muted,
  listBullet: accent, bold, italic: ansi(3), strikethrough: ansi(9), underline: ansi(4) };
const prose = (text: string, width: number) => new Markdown(clean(text), 0, 0, markdownTheme, undefined, { renderLatex: false }).render(Math.max(1, width));
const rule = (width: number) => muted("─".repeat(Math.max(1, width)));
const status = (value: WatchConversation["status"]) => value === "working" ? accent("● Working")
  : value === "waiting" ? warning("◷ Waiting") : value === "unavailable" ? warning("○ Not running") : muted("○ Idle");
const component = (render: (width: number) => string[], handleMouse?: Component["handleMouse"]): Component => ({ render, handleMouse, invalidate() {} });
type Hit = { top: number; bottom: number; key: string };

/** A separate observer. Only the viewer's terminal and discovery child are owned here. */
export async function watchInTerminal(options: WatchOptions): Promise<void> {
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: false,
    scrollToEndIndicator: () => view.view === "conversation" && view.filter === "updates" && !view.query && !view.help ? accent(" ↓ Latest · f ") : "" });
  const controller = new AbortController();
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  let closed = false;
  const close = () => { if (!closed) { closed = true; controller.abort(); finish(); } };

  class WatchView implements Component {
    view: "runs" | "agents" | "conversation" | "detail" = "runs";
    runs: WatchRun[] = [];
    snapshots = new Map<string, WatchSnapshot>();
    run?: WatchRun;
    conversation?: WatchConversation;
    page?: WatchPage;
    detail?: WatchActivity;
    detailReturn?: { key: string; top: number };
    filter: FeedFilter = "updates";
    expanded = new Set<string>();
    selected = "";
    agentIndex = 0;
    focus: "feed" | "agents" = "feed";
    issues: string[] = [];
    error = "";
    busy = false;
    reading = false;
    autoOpen = true;
    observedAt?: number;
    navigation = 0;
    timer?: ReturnType<typeof setTimeout>;
    hits: Hit[] = [];
    agentHits: Hit[] = [];
    tabHits: Array<{ from: number; to: number; filter: FeedFilter }> = [];
    search = new Input({ prompt: " / ", placeholder: "Search loaded messages, commands and results…" });
    searching = false;
    query = "";
    help = false;
    light = false;
    lastReadCount = 0;
    anchor?: { key: string; offset: number };
    updateLinkLine = -1;
    readonly feed = component(width => this.renderFeed(width), event => this.feedMouse(event));
    readonly scroll = new ScrollView(this.feed, { primary: true, follow: "end", scrollbar: "auto",
      scrollbarTrackStyle: muted, scrollbarThumbStyle: accent });
    readonly sidebar = new ScrollView(component(width => this.renderAgents(width), event => this.agentsMouse(event)), { scrollbar: "auto" });
    readonly layout = new VStack([
      { component: component(width => this.renderHeader(width), event => this.headerMouse(event)), shrink: 0 },
      { component: new HStack([
        { component: component(() => [""]), basis: 2, shrink: 1 },
        { component: this.sidebar, basis: 28, shrink: 0, visible: viewport => viewport.width >= 112 && Boolean(this.run) && !this.help },
        { component: component(() => [""]), basis: 3, shrink: 0, visible: viewport => viewport.width >= 112 && Boolean(this.run) && !this.help },
        { component: new VStack([
          { component: component(width => this.renderSummary(width), event => this.summaryMouse(event)), shrink: 0 },
          { component: component(width => this.renderTabs(width), event => this.tabsMouse(event)), shrink: 0 },
          { component: this.scroll, basis: 0, grow: 1, minSize: 3 },
        ]), basis: 0, grow: 1, minSize: 10, maxSize: 108 },
        { component: component(() => [""]), basis: 2, shrink: 1 },
      ]), basis: 0, grow: 1, minSize: 3 },
      { component: component(width => this.renderFooter(width)), shrink: 0 },
    ]);

    constructor() {
      this.search.onSubmit = () => { this.searching = false; this.search.focused = false; this.redraw(); };
      this.search.onEscape = () => { this.searching = false; this.search.focused = false; this.setQuery(""); };
    }
    invalidate(): void {}
    render(): string[] { return []; }
    get snapshot(): WatchSnapshot | undefined { return this.run && this.snapshots.get(this.run.key); }
    get conversations(): WatchConversation[] { return this.snapshot?.conversations ?? []; }
    get unassignedStores() { return (this.run?.stores ?? []).filter(store => !this.conversations.some(c => c.agent === store.agent)); }
    unassignedStatus(agent: string): string { return this.snapshot?.unavailableAgents.includes(agent) ? "State unavailable" : "No conversation yet"; }
    get entries(): WatchActivity[] { return this.page?.entries ?? []; }
    get rows(): FeedRow[] { return feedRows(this.entries, this.filter, this.expanded, this.query); }
    get following(): boolean { return this.view === "conversation" && this.scroll.isFollowingEnd && !this.query && this.filter === "updates"; }
    runTitle(run: WatchRun): string {
      return humanName(run.session === "." ? options.namespace ?? run.path.split("/").at(-1) ?? "Agent service" : run.session.replace(/-\d{8}$/, ""));
    }
    highlight(text: string, width: number): string {
      return ansi(this.light ? "48;5;153;38;5;17" : "48;5;24;38;5;231")(pad(stripTerminalSequences(text), width));
    }
    redraw(): void { if (!closed) tui.requestRender(); }
    resetScroll(): void {
      this.selected = "";
      // The previous view may fit on screen. Do not carry its follow-end state
      // into a longer agent list, search result, or inspector on the next layout.
      this.scroll.scrollTo(0, { disableFollow: true });
      tui.resetTextSelection();
    }

    async refresh(): Promise<void> {
      if (this.busy || closed) return;
      this.busy = true;
      const scope = this.run?.key;
      try {
        const discovery = await discoverWatchRuns({ ...options, signal: controller.signal,
          session: this.run?.session ?? (this.autoOpen ? options.session : undefined) });
        if (closed || scope !== this.run?.key) return;
        this.issues = discovery.issues;
        this.runs = discovery.runs;
        const summaries = await Promise.allSettled(this.runs.map(run => readWatchRun(run)));
        if (closed || scope !== this.run?.key) return;
        const selectedAgent = this.conversations[this.agentIndex]?.key;
        for (const result of summaries) {
          if (result.status === "fulfilled") this.snapshots.set(result.value.run.key, result.value);
          else this.issues.push(result.reason instanceof Error ? result.reason.message : "Could not read session.");
        }
        if (this.run) {
          const next = this.runs.find(run => run.key === this.run!.key);
          if (next) this.run = next;
          else this.issues.push("Session unavailable. Showing the last observation.");
          this.agentIndex = Math.max(0, this.conversations.findIndex(c => c.key === selectedAgent));
          if (this.conversation) this.conversation = this.conversations.find(c => c.key === this.conversation!.key) ?? this.conversation;
        }
        if (this.autoOpen && this.view === "runs" && this.runs.length === 1) await this.openRun(this.runs[0]);
        this.error = "";
        if (this.view === "conversation" && (!this.page || this.following) && !this.help) await this.latest(!this.page);
        if (this.view === "detail" && this.run && this.detail) {
          const id = this.detail.id, key = this.run.key;
          const entry = await readWatchActivity(this.run, this.detail);
          if (this.view === "detail" && this.run?.key === key && this.detail?.id === id) {
            if (entry) this.detail = entry;
            else this.error = "Event unavailable. Showing the last observation.";
          }
        }
        this.observedAt = Date.now();
      } catch (error) {
        if (!closed) this.error = error instanceof Error ? error.message : "Observation failed.";
      } finally {
        this.busy = false; this.redraw();
        if (!closed) this.timer = setTimeout(() => { void this.refresh(); }, 2000);
      }
    }
    async openRun(run: WatchRun): Promise<void> {
      this.navigation++; this.autoOpen = false; this.run = run; this.view = "agents";
      terminal.setTitle(`Dispatch Watch · ${oneLine(run.session)}`);
      this.agentIndex = 0; this.resetScroll();
      this.sidebar.scrollToStart();
      this.selected = this.conversations[0]?.key ?? "";
      if (this.conversations.length === 1) await this.openConversation(this.conversations[0]);
      this.redraw();
    }
    async openConversation(conversation: WatchConversation): Promise<void> {
      this.navigation++; this.conversation = conversation; this.page = undefined; this.view = "conversation";
      this.agentIndex = Math.max(0, this.conversations.findIndex(c => c.key === conversation.key));
      this.focus = "feed"; this.filter = "updates"; this.query = ""; this.search.setValue(""); this.expanded.clear();
      this.resetScroll(); await this.latest();
    }
    async latest(jump = true): Promise<void> {
      if (!this.run || !this.conversation || this.reading) return;
      if (jump) { this.navigation++; this.filter = "updates"; this.query = ""; this.search.setValue(""); this.expanded.clear(); }
      this.reading = true;
      const key = this.conversation.key, runKey = this.run.key, navigation = this.navigation;
      const wasFollowing = jump || this.following;
      try {
        const page = await readWatchConversation(this.run, key);
        if (this.run?.key === runKey && this.conversation?.key === key && this.navigation === navigation && this.view === "conversation" && !closed && (jump || this.following)) {
          const previous = new Map(this.entries.map(entry => [entry.id, entry]));
          const overlaps = page.entries.some(entry => previous.has(entry.id));
          for (const entry of page.entries) previous.set(entry.id, entry);
          this.page = this.page && overlaps ? { ...this.page, entries: [...previous.values()], observedAt: page.observedAt } : page;
          this.lastReadCount = this.conversation.entryCount;
          if (wasFollowing) { this.selected = this.rows.at(-1)?.key ?? ""; this.scroll.scrollToEnd(); }
        }
      } catch (error) { this.error = error instanceof Error ? error.message : "Could not read conversation."; }
      finally { this.reading = false; this.redraw(); }
    }
    async earlier(): Promise<void> {
      if (!this.run || !this.conversation || !this.page?.hasEarlier || this.reading) return;
      this.navigation++; this.reading = true;
      const key = this.conversation.key, runKey = this.run.key, navigation = this.navigation;
      const visible = this.hits.find(hit => hit.bottom > this.scroll.scrollTop && hit.key !== "earlier");
      const anchor = visible && { key: visible.key, offset: this.scroll.scrollTop - visible.top };
      try {
        const page = await readWatchConversation(this.run, key, this.page.before);
        if (this.run?.key === runKey && this.conversation?.key === key && this.navigation === navigation && this.view === "conversation" && !closed) {
          const current = new Set(this.entries.map(entry => entry.id));
          this.page = { ...page, entries: [...page.entries.filter(entry => !current.has(entry.id)), ...this.entries] };
          this.anchor = anchor; this.scroll.scrollTo(this.scroll.scrollTop, { disableFollow: true });
        }
      } catch (error) { this.error = error instanceof Error ? error.message : "Could not load earlier history."; }
      finally { this.reading = false; this.redraw(); }
    }
    openDetail(entry: WatchActivity): void {
      this.navigation++; this.detailReturn = { key: this.selected, top: this.scroll.scrollTop };
      this.detail = entry; this.view = "detail"; this.resetScroll(); this.redraw();
    }
    open(key?: string): void {
      if (this.help) return;
      if (this.focus === "agents") { const c = this.conversations[this.agentIndex]; if (c) void this.openConversation(c); return; }
      if (!key) {
        const visible = this.hits.filter(hit => hit.bottom > this.scroll.scrollTop && hit.top < this.scroll.scrollTop + this.scroll.viewportHeight);
        key = visible.find(hit => hit.key === this.selected)?.key ?? visible[0]?.key;
      }
      if (!key) return;
      this.selected = key;
      if (key === "earlier") { void this.earlier(); return; }
      if (this.view === "runs") { const run = this.runs.find(item => item.key === key); if (run) void this.openRun(run); }
      else if (this.view === "agents") { const c = this.conversations.find(item => item.key === key); if (c) void this.openConversation(c); }
      else if (this.view === "conversation") {
        const row = this.rows.find(item => item.key === key);
        if (row?.kind === "group") {
          this.navigation++; this.scroll.scrollTo(this.scroll.scrollTop, { disableFollow: true });
          if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
        } else if (row) this.openDetail(row.activity);
      }
      this.redraw();
    }
    back(): void {
      this.navigation++;
      if (this.help) { this.help = false; this.resetScroll(); }
      else if (this.view === "detail") {
        this.view = "conversation"; this.selected = this.detailReturn?.key ?? "";
        this.scroll.scrollTo(this.detailReturn?.top ?? 0, { disableFollow: true });
      } else if (this.query) this.setQuery("");
      else if (this.view === "conversation") { this.view = "agents"; this.conversation = undefined; this.page = undefined; this.resetScroll(); }
      else if (this.view === "agents") this.showSessions();
      this.redraw();
    }
    showSessions(): void {
      this.navigation++; this.view = "runs"; this.run = undefined; this.conversation = undefined; this.page = undefined;
      this.autoOpen = false; this.focus = "feed"; this.resetScroll();
      terminal.setTitle("Dispatch Watch · Sessions");
      if (this.timer) clearTimeout(this.timer);
      void this.refresh();
    }
    setFilter(filter: FeedFilter): void {
      this.navigation++; this.filter = filter; this.resetScroll(); this.redraw();
    }
    setQuery(query: string): void {
      this.navigation++; this.query = query; this.search.setValue(query); this.resetScroll(); this.redraw();
    }
    move(delta: number): void {
      this.navigation++;
      if (this.focus === "agents") {
        this.agentIndex = Math.max(0, Math.min(this.conversations.length - 1, this.agentIndex + delta));
        this.sidebar.scrollTo(Math.max(0, this.agentIndex * 4 - 2));
      } else if (this.view === "detail" || this.help) this.scroll.scrollBy(delta);
      else {
        const visible = this.hits.filter(hit => hit.bottom > this.scroll.scrollTop && hit.top < this.scroll.scrollTop + this.scroll.viewportHeight);
        const current = this.hits.find(hit => hit.key === this.selected);
        const key = current && visible.includes(current) ? current.key : (delta < 0 ? visible.at(-1) : visible[0])?.key;
        const at = this.hits.findIndex(hit => hit.key === key);
        const hit = this.hits[Math.max(0, Math.min(this.hits.length - 1, at + delta))];
        if (hit) {
          this.selected = hit.key;
          const top = hit.top < this.scroll.scrollTop ? hit.top : hit.bottom > this.scroll.scrollTop + this.scroll.viewportHeight
            ? Math.max(0, hit.bottom - this.scroll.viewportHeight) : this.scroll.scrollTop;
          this.scroll.scrollTo(top, { disableFollow: true });
        }
      }
      this.redraw();
    }
    handleInput(data: string): void {
      if (matchesKey(data, Key.ctrl("c"))) { close(); return; }
      if (this.searching) {
        this.search.handleInput(data);
        if (this.query !== this.search.getValue()) this.setQuery(this.search.getValue());
        this.redraw(); return;
      }
      if (data === "q") close();
      else if (data === "?") { this.help = !this.help; this.resetScroll(); this.redraw(); }
      else if (matchesKey(data, Key.escape) || matchesKey(data, Key.left)) this.back();
      else if (matchesKey(data, Key.enter) || matchesKey(data, Key.right)) this.open();
      else if (matchesKey(data, Key.up) || data === "k") this.move(-1);
      else if (matchesKey(data, Key.down) || data === "j") this.move(1);
      else if (matchesKey(data, Key.tab) && this.run && terminal.columns >= 112) {
        this.focus = this.focus === "agents" ? "feed" : "agents"; this.redraw();
      } else if (data === "s") { this.showSessions(); this.redraw(); }
      else if (data === "a" && this.run) { this.view = "agents"; this.focus = "feed"; this.resetScroll(); this.redraw(); }
      else if (data === "r") { if (this.timer) clearTimeout(this.timer); void this.refresh(); }
      else if (data === "u" && this.view === "conversation" && this.conversation?.latestMessage) this.openDetail(this.conversation.latestMessage);
      else if (this.view === "conversation") {
        if (data === "f" || data === "G" || matchesKey(data, Key.end)) void this.latest();
        else if (data === "b") void this.earlier();
        else if (data === "1") this.setFilter("updates");
        else if (data === "2") this.setFilter("all");
        else if (data === "3") this.setFilter("errors");
        else if (data === "/") { this.searching = true; this.search.focused = true; this.redraw(); }
        else if (data === "g" || matchesKey(data, Key.home)) { this.scroll.scrollToStart(); this.selected = this.hits[0]?.key ?? ""; this.redraw(); }
      }
    }
    feedMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type === "wheel") return undefined; // Stock viewport scrolling and text selection.
      const hit = this.hits.find(hit => event.y >= hit.top && event.y < hit.bottom);
      if (!hit || event.shift || event.button !== "left" || this.help || this.view === "detail") return undefined;
      // Only the card heading is a button; prose remains selectable.
      if (event.y !== hit.top) return undefined;
      if (event.type === "press") return { handled: true };
      if (event.type === "click") { this.focus = "feed"; this.selected = hit.key; this.open(hit.key); return { handled: true }; }
      return undefined;
    }
    agentsMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.type === "wheel" || event.shift || event.button !== "left") return undefined;
      const hit = this.agentHits.find(hit => event.y >= hit.top && event.y < hit.bottom);
      if (!hit) return undefined;
      if (event.type === "press") return { handled: true };
      if (event.type === "click") { const c = this.conversations.find(item => item.key === hit.key); if (c) void this.openConversation(c); return { handled: true }; }
      return undefined;
    }
    headerMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.y !== 0 || event.x < 2 || event.x > 17 || event.button !== "left") return undefined;
      if (event.type === "press") return { handled: true };
      if (event.type === "click") { this.showSessions(); return { handled: true }; }
      return undefined;
    }
    summaryMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if ((event.y !== 0 && event.y !== this.updateLinkLine) || !this.conversation?.latestMessage || this.view !== "conversation" || event.button !== "left") return undefined;
      if (event.type === "press") return { handled: true };
      if (event.type === "click") { this.openDetail(this.conversation.latestMessage); return { handled: true }; }
      return undefined;
    }
    tabsMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
      if (event.y !== 0 || this.view !== "conversation" || event.button !== "left") return undefined;
      const tab = this.tabHits.find(tab => event.x >= tab.from && event.x < tab.to);
      if (!tab) return undefined;
      if (event.type === "press") return { handled: true };
      if (event.type === "click") { this.setFilter(tab.filter); return { handled: true }; }
      return undefined;
    }
    renderHeader(width: number): string[] {
      const title = this.run ? this.runTitle(this.run) : "Your agent sessions";
      const mode = this.run ? this.run.pids.length ? success("● Process running") : muted("○ Saved session") : "";
      return [fit(`  ${bold("DISPATCH WATCH")}  ${muted("/")}  ${bold(title)}`, width),
        fit(`  ${mode}${this.run ? `  ·  ${this.conversations.length} ${this.conversations.length === 1 ? "conversation" : "conversations"}  ·  ${muted(clean(this.run.session))}` : "Choose a session to see progress and inspect its agents."}`, width), ""];
    }
    renderAgents(width: number): string[] {
      this.agentHits = [];
      const lines = [bold(this.focus === "agents" ? "AGENTS  ←" : "AGENTS"), muted("Click an agent to open"), ""];
      for (const [index, c] of this.conversations.entries()) {
        const active = this.conversation?.key === c.key || this.focus === "agents" && this.agentIndex === index;
        const top = lines.length;
        const name = c.parentKey ? `↳ ${oneLine(c.title) || humanName(c.agent)}` : humanName(c.agent);
        const title = fit(`${active ? "▸ " : "  "}${name}`, width);
        lines.push(active ? this.highlight(title, width) : title, fit(`  ${status(c.status)}`, width),
          fit(`  ${muted(`#${c.conversationId} · ${age(c.updatedAt)} ago`)}`, width), "");
        this.agentHits.push({ key: c.key, top, bottom: lines.length - 1 });
      }
      for (const store of this.unassignedStores) lines.push(fit(humanName(store.agent), width), muted(`  ${this.unassignedStatus(store.agent)}`), "");
      lines.push(rule(width), muted("a  All agents"), muted("s  Change session"), "", muted("Read-only · q closes viewer"));
      return lines;
    }
    renderSummary(width: number): string[] {
      this.updateLinkLine = -1;
      if (this.help || this.view === "runs" || this.view === "agents") return [];
      if (this.view === "detail") return [accent("← Esc  Back to activity"), ""];
      const c = this.conversation;
      if (!c) return [];
      const message = c.latestMessage;
      const compact = terminal.rows < 28;
      const lines = [bold(fit(`LATEST UPDATE${message ? `  ${clock(message.at)} · ${age(message.at)} ago` : ""}`, width))];
      if (message) {
        const rendered = prose(message.text, width - 2), limit = compact ? 2 : Math.min(8, Math.max(3, Math.floor(terminal.rows / 6)));
        lines.push(...rendered.slice(0, limit).map(line => `  ${line}`));
        this.updateLinkLine = lines.length;
        lines.push(muted(rendered.length > limit ? "  … u Read full update" : "  u Read full update"));
      } else lines.push(muted("  No public update recorded yet."));
      lines.push("", fit(`${status(c.status)}${c.startedAt ? `  ·  ${age(c.startedAt)} elapsed` : ""}`, width));
      const current = c.currentTools?.map(actionTitle).join(" · ") || (c.active ? c.activity : "No unfinished tasks recorded");
      lines.push(fit(`Now  ${oneLine(current)}`, width), "");
      return lines;
    }
    renderTabs(width: number): string[] {
      this.tabHits = [];
      if (this.help || this.view !== "conversation") return [];
      const errors = pairedActivity(this.entries).filter(e => e.kind !== "message" && toolState(e) === "error").length;
      let line = "";
      for (const [filter, text] of [["updates", "1 Updates"], ["all", "2 All activity"], ["errors", `3 Errors${errors ? ` (${errors})` : ""}`]] as const) {
        const from = visibleWidth(line), label = ` ${text} `;
        line += this.filter === filter ? this.highlight(label, visibleWidth(label)) : muted(label);
        this.tabHits.push({ filter, from, to: visibleWidth(line) }); line += " ";
      }
      const info = this.query ? `${this.rows.length} matches in loaded history · Esc Clear` : this.filter === "errors" ? "Tool errors in loaded history · f Live updates" : this.following ? "LIVE · Following latest" :
        `Reading history${this.conversation && this.conversation.entryCount > this.lastReadCount ? ` · ${this.conversation.entryCount - this.lastReadCount} new records` : ""} · f Latest`;
      return [fit(line, width), this.searching ? this.search.render(width)[0] : fit(this.query ? ` / ${this.query}  ·  ${info}` : muted(info), width), rule(width)];
    }
    renderFeed(width: number): string[] {
      this.hits = [];
      if (this.help) return this.renderHelp(width);
      if (this.view === "detail" && this.detail) return this.renderDetail(this.detail, width);
      const lines: string[] = [];
      const add = (key: string, content: string[]) => {
        const top = lines.length;
        if (!this.selected) this.selected = key;
        const selected = this.selected === key && this.focus === "feed";
        lines.push(...content.map((line, i) => i === 0 ? selected ? this.highlight(` ${line}`, width) : fit(` ${line}`, width) : fit(`  ${line}`, width)), "");
        this.hits.push({ key, top, bottom: lines.length - 1 });
      };
      if (this.view === "runs") {
        lines.push(bold("SESSIONS"), "");
        if (!this.runs.length) lines.push(this.observedAt ? "No running sessions found. Waiting for a session…" : "Looking for running sessions…");
        for (const run of this.runs) {
          const snapshot = this.snapshots.get(run.key), conversations = snapshot?.conversations ?? [];
          const latest = conversations.flatMap(c => c.latestMessage ? [c.latestMessage] : []).sort((a,b) => (b.at ?? 0) - (a.at ?? 0))[0];
          add(run.key, [bold(this.runTitle(run)),
            `${conversations.length} ${conversations.length === 1 ? "conversation" : "conversations"} · ${conversations.filter(c => c.status === "working").length} working · ${run.pids.length ? "Process running" : "Saved session"}`,
            ...(latest ? prose(latest.text, width - 4).slice(0, 3) : [muted("No public update yet")])]);
        }
      } else if (this.view === "agents") {
        lines.push(bold("AGENTS"), muted("Select an agent to read its updates and activity."), "");
        for (const c of this.conversations) add(c.key, [bold(`${humanName(c.agent)} · #${c.conversationId}`),
          `${status(c.status)} · Updated ${age(c.updatedAt)} ago`,
          ...(c.parentKey ? [oneLine(c.title)] : []),
          ...(c.latestMessage ? prose(c.latestMessage.text, width - 4).slice(0, 4) : [muted("No public update yet")])]);
        for (const store of this.unassignedStores) lines.push(fit(`  ${bold(humanName(store.agent))}`, width),
          muted(`  ${this.unassignedStatus(store.agent)}`), "");
        if (!this.conversations.length) lines.push("No conversations available yet.");
      } else {
        if (this.page?.hasEarlier) add("earlier", [accent(this.reading ? "Loading earlier history…" : "↑ Load earlier history · b")]);
        const rows = this.rows;
        if (!rows.length) lines.push(this.reading ? "Reading activity…" : this.query ? "No matches in loaded history. Load earlier history to search further." : this.filter === "errors" ? "No tool errors in loaded history." : "No public messages or tool activity yet.");
        for (const row of rows) {
          if (row.kind === "message") {
            const text = prose(row.activity.text, width - 4), limit = row.activity.role === "user" ? 3 : 7;
            add(row.key, [bold(`${row.activity.role === "user" ? "YOU" : "UPDATE"}  ${clock(row.activity.at)}`),
              ...text.slice(0, limit), ...(text.length > limit ? [accent("… Enter to read full message")] : [])]);
          } else if (row.kind === "group") {
            const tools = row.tools!, done = tools.filter(t => toolState(t) === "done").length,
              errors = tools.filter(t => toolState(t) === "error").length, pending = tools.length - done - errors;
            const counts = [done ? `${done} returned` : "", errors ? failure(`${errors} ${errors === 1 ? "error" : "errors"}`) : "", pending ? `${pending} awaiting result` : ""].filter(Boolean).join(" · ");
            const recent = tools.at(-1)!;
            add(row.key, [`${this.expanded.has(row.key) ? "▾" : "▸"} ${bold(`${tools.length} ${tools.length === 1 ? "action" : "actions"}`)}  ${muted(`${clock(row.activity.at)}–${clock(recent.result?.at ?? recent.at)}`)}  ${counts}`,
              `${muted("Latest:")} ${actionTitle(recent)}`, muted(this.expanded.has(row.key) ? "Enter to collapse" : "Enter to inspect commands and results")]);
          } else {
            const state = toolState(row.activity), indicator = state === "error" ? failure("! Error") : state === "done" ? success("✓ Returned") : warning("◷ Awaiting result");
            const matched = this.query && [row.activity.text, JSON.stringify(row.activity.arguments), row.activity.result?.text]
              .map(text => oneLine(text ?? "")).find(text => text.toLocaleLowerCase().includes(this.query.toLocaleLowerCase()));
            const offset = matched ? Math.max(0, matched.toLocaleLowerCase().indexOf(this.query.toLocaleLowerCase()) - 35) : 0;
            add(row.key, [`${indicator}  ${actionTitle(row.activity)}`, muted(`${clock(row.activity.at)} · ${oneLine(row.activity.title)} · Enter for details`),
              ...(matched ? [`${offset ? "…" : ""}${matched.slice(offset)}`] : [])]);
          }
        }
      }
      if (this.anchor) {
        const hit = this.hits.find(hit => hit.key === this.anchor!.key);
        if (hit) this.scroll.scrollTo(Math.max(0, hit.top + this.anchor.offset), { disableFollow: true });
        this.anchor = undefined;
      }
      return lines;
    }
    renderDetail(entry: WatchActivity, width: number): string[] {
      if (entry.kind === "message") return [bold(`${entry.role === "user" ? "Assignment" : "Agent update"} · ${clock(entry.at)}`), "", ...prose(entry.text, width - 2), ""];
      const state = toolState(entry), title = actionTitle(entry);
      const lines = [bold(fit(title, width)),
        fit(`${oneLine(entry.title)} · ${clock(entry.at)} · ${state === "error" ? failure("Tool reported an error") : state === "done" ? success("Result received") : warning("Awaiting result")}`, width), ""];
      if (entry.kind === "tool-call") {
        const args = entry.arguments && typeof entry.arguments === "object" ? entry.arguments as Record<string, unknown> : {};
        const command = args.command ?? args.cmd;
        lines.push(bold(typeof command === "string" ? "COMMAND" : "ARGUMENTS"), rule(width));
        lines.push(...wrapTextWithAnsi(clean(typeof command === "string" ? command : JSON.stringify(args, null, 2)), width));
        const extra = Object.fromEntries(Object.entries(args).filter(([key]) => !["command", "cmd"].includes(key)));
        if (typeof command === "string" && Object.keys(extra).length) lines.push("", ...wrapTextWithAnsi(clean(JSON.stringify(extra, null, 2)), width));
        lines.push("", bold(`RESULT${entry.result?.at ? ` · ${clock(entry.result.at)}` : ""}`), rule(width),
          ...wrapTextWithAnsi(clean(entry.result?.text ?? "No matching result recorded yet. This view updates automatically."), width));
      } else lines.push(bold("RESULT"), rule(width), ...wrapTextWithAnsi(clean(entry.text), width));
      return [...lines, ""];
    }
    renderHelp(width: number): string[] {
      return prose(`# Watch, without the noise\n\nThe latest public update stays at the top. **Updates** folds consecutive tool calls into action groups. Open a group, then a command, to inspect exact arguments and its matching result.\n\n- **Click** a session, agent, or card heading to open it.\n- **Scroll / Page Up / Page Down** to read at your own pace.\n- **↑ ↓ / j k** select a card; **Enter** opens it.\n- **u** reads the full latest agent update.\n- **1 / 2 / 3** switch Updates, All activity, and Errors.\n- **/** searches loaded messages, commands and results. **Esc** clears the search.\n- **b** loads earlier history; it also extends search coverage.\n- **f / End** returns to live Updates.\n- **Tab** switches keyboard focus to the agent list on wide screens.\n- **a** shows all agents; **s** changes session.\n- **Esc** goes back; **?** closes help.\n- **q / Ctrl+C** closes only the viewer.\n\nDrag across prose to select text. Use your terminal's copy shortcut. Shift-drag bypasses clickable headings.\n\n“Process running” describes the observed process. “Working” and “Waiting” describe recorded tasks. Returned tools and idle agents do not establish a successful workflow outcome.`, width);
    }
    renderFooter(width: number): string[] {
      const issues = [this.error, ...this.issues, ...(this.snapshot?.issues ?? [])].filter(Boolean);
      const notice = issues.length ? warning(fit(`! ${oneLine(issues[0])}`, width - 4)) : muted(`Updated ${clock(this.observedAt)} · Read-only · Quitting leaves agents running`);
      const hints = this.help ? "? / Esc Close help    q Quit viewer" : this.searching ? "Type to filter    Enter Browse matches    Esc Clear search" : this.view === "detail" ?
        "Scroll / PgUp PgDn Read    Esc Back    ? Help    q Quit" : this.view === "conversation" ?
          "↑↓ Select   Enter Open   / Search   u Update   f Live   ? Help   q Quit" : "↑↓ Select   Enter Open   s Sessions   ? Help   q Quit";
      return ["", fit(`  ${notice}`, width), fit(`  ${hints}`, width)];
    }
  }
  const view = new WatchView();
  const terminate = () => close();
  process.once("SIGINT", terminate); process.once("SIGTERM", terminate);
  const stopColorUpdates = tui.onTerminalColorSchemeChange(scheme => { view.light = scheme === "light"; view.redraw(); });
  try {
    tui.setLayoutRoot(view.layout); tui.setFocus(view); tui.start();
    void tui.queryTerminalColors({ timeoutMs: 500 }).then(colors => {
      if (colors.background) view.light = (colors.background.r + colors.background.g + colors.background.b) / 3 > 127;
      view.redraw();
    });
    void view.refresh(); await done;
  } finally {
    closed = true; controller.abort(); stopColorUpdates();
    if (view.timer) clearTimeout(view.timer);
    process.removeListener("SIGINT", terminate); process.removeListener("SIGTERM", terminate);
    tui.stop({ preserveScreen: true }); await terminal.drainInput(); process.stdin.pause();
  }
}
