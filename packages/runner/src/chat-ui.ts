import { Editor, Input, Markdown, ProcessTerminal, ScrollView, SelectList, TuiAltScreen, VStack,
  matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi,
  type AutocompleteProvider, type Component, type MarkdownTheme, type OverlayHandle, type SelectItem,
} from "@earendil-works/pi-tui";
import type { ChatSnapshot } from "./chat.js";
import type { ChatToolCall } from "./chat-tools.js";
import type { ServiceResults } from "./protocol.js";
import { terminalText } from "./terminal-output.js";

export type ChatUIState = {
  snapshot?: ChatSnapshot;
  agents: ServiceResults["agents"];
  connection: "connecting" | "connected" | "disconnected";
  notice?: string;
  pending?: string;
};

const ansi = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[0m`;
const bold = ansi(1), accent = ansi(36), muted = ansi(90), warning = ansi(33), failure = ansi(31), success = ansi(32);
const identity = (text: string) => text;
const oneLine = (text: string) => terminalText(text).replace(/\s+/g, " ");
const fit = (text: string, width: number) => truncateToWidth(text, Math.max(1, width), "…");
const component = (render: Component["render"]): Component => ({ render, invalidate() {} });
function outputText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(part => part?.type === "text" && typeof part.text === "string"
    ? part.text : JSON.stringify(part, null, 2)).join("\n");
  return JSON.stringify(value, null, 2);
}
const markdownTheme: MarkdownTheme = { heading: bold, link: accent, linkUrl: muted, code: accent,
  codeBlock: identity, codeBlockBorder: muted, quote: identity, quoteBorder: muted, hr: muted,
  listBullet: accent, bold, italic: ansi(3), strikethrough: ansi(9), underline: ansi(4) };
const selectTheme = { selectedPrefix: accent, selectedText: bold, description: muted, scrollInfo: muted, noMatch: warning };
const commands = [
  ["/new", "New conversation with this agent"], ["/chats", "Find a saved conversation"],
  ["/agents", "Choose an agent"], ["/history", "Refresh and scroll to the beginning"],
  ["/stop", "Cancel this conversation’s owned work"], ["/reconnect", "Reconnect to the same host"],
  ["/retry", "Retry an uncertain send with its original ID"], ["/help", "Commands and keyboard shortcuts"],
  ["/quit", "Disconnect; host work continues"],
].map(([value, description]) => ({ value, label: value, description }));

// Only complete supported commands: this client has no local file-search authority.
const autocomplete: AutocompleteProvider = {
  triggerCharacters: ["/"],
  async getSuggestions(lines, line, column) {
    const prefix = lines[line].slice(0, column);
    if (line !== 0 || lines.length !== 1 || !/^\/\w*$/.test(prefix)) return null;
    const items = commands.filter(item => item.value.startsWith(prefix));
    return items.length ? { items, prefix } : null;
  },
  applyCompletion(lines, line, column, item, prefix) {
    return { lines: [...lines.slice(0, line), item.value + lines[line].slice(column), ...lines.slice(line + 1)],
      cursorLine: line, cursorCol: column - prefix.length + item.value.length };
  },
};

type View = { top: number; following: boolean; expanded: Set<string>; tools: Set<string>; expandNew: boolean };
type Row = { id: string; top: number; bottom: number };

class ChatScroll extends ScrollView {
  restoreTop?: number;
  override updateLayout(height: number, viewport: number, requestRender: () => void): void {
    super.updateLayout(height, viewport, requestRender);
    // ScrollView clamps against its last layout; restore only after the new content is measured.
    if (this.restoreTop !== undefined) {
      const top = this.restoreTop;
      this.restoreTop = undefined;
      this.scrollTo(top, { disableFollow: true });
    }
  }
}

export class ChatUI {
  private readonly terminal = new ProcessTerminal();
  private readonly tui = new TuiAltScreen(this.terminal, true, undefined, {
    mouse: true, copyOnSelect: false, scrollToEndIndicator: () => accent(" ↓ Latest · Ctrl+End "),
  });
  private readonly editor = new Editor(this.tui, { borderColor: accent, selectList: selectTheme }, { paddingX: 1 });
  private readonly transcript = component(width => this.renderTranscript(width));
  private readonly scroll = new ChatScroll(this.transcript, { primary: true, follow: "end", scrollbar: "auto",
    scrollbarTrackStyle: muted, scrollbarThumbStyle: accent });
  private state: ChatUIState = { agents: [], connection: "connecting" };
  private readonly prose = new Map<string, Markdown>();
  private readonly views = new Map<string, View>();
  private expanded = new Set<string>();
  private expandNew = false;
  private toolIds = new Set<string>();
  private toolHits = new Map<number, string>();
  private rows: Row[] = [];
  private anchor?: { id: string; offset: number; top: number };
  private overlay?: OverlayHandle;
  private started = false;

  constructor(private readonly onSubmit: (text: string) => void, private readonly onQuit: () => void) {
    this.editor.setAutocompleteProvider(autocomplete);
    this.editor.onSubmit = text => {
      if (!text.trim()) return;
      this.editor.addToHistory(text);
      if (!text.startsWith("/")) this.scroll.scrollToEnd();
      this.onSubmit(text);
    };
    this.transcript.handleMouse = event => {
      const id = this.toolHits.get(event.y);
      if (event.type !== "click" || event.button !== "left" || !id) return;
      this.rememberAnchor();
      if (this.expanded.has(id)) this.expanded.delete(id); else this.expanded.add(id);
      this.tui.requestRender();
      return { handled: true };
    };
    this.tui.setLayoutRoot(new VStack([
      { component: component(width => this.renderHeader(width)), shrink: 0 },
      { component: this.scroll, basis: 0, grow: 1, minSize: 1 },
      { component: component(width => this.renderStatus(width)), shrink: 0 },
      { component: this.editor, shrink: 0 },
      { component: component(width => [fit(muted(width < 65
        ? "Enter send · Alt+Enter newline · /help"
        : "Enter send · Alt+Enter newline · Ctrl+O tools · PgUp/PgDn scroll · /help"), width)]), shrink: 0 },
    ]));
    this.tui.setFocus(this.editor);
    this.tui.addInputListener(data => {
      if (this.tui.hasOverlay()) return;
      if (matchesKey(data, "ctrl+c")) {
        if (this.tui.hasActiveSelection()) void this.tui.copyActiveSelectionToClipboard();
        else if (this.editor.isShowingAutocomplete()) this.editor.handleInput("\x1b");
        else if (this.getDraft()) this.setDraft("");
        else this.onQuit();
        return { consume: true };
      }
      if (matchesKey(data, "ctrl+d") && !this.getDraft()) { this.onQuit(); return { consume: true }; }
      if (matchesKey(data, "f1")) { this.onSubmit("/help"); return { consume: true }; }
      if (matchesKey(data, "ctrl+p")) { this.onSubmit("/chats"); return { consume: true }; }
      if (matchesKey(data, "ctrl+g")) { this.onSubmit("/agents"); return { consume: true }; }
      if (matchesKey(data, "ctrl+o")) {
        this.rememberAnchor();
        this.expandNew = !this.expandNew;
        this.expanded = new Set(this.expandNew ? this.toolIds : []);
        this.tui.requestRender();
        return { consume: true };
      }
      if (matchesKey(data, "alt+enter")) return { data: "\n" };
    });
  }

  start(): void { this.started = true; this.tui.start(); }
  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.overlay?.hide();
    this.tui.stop();
  }
  getDraft(): string { return this.editor.getExpandedText(); }
  setDraft(text: string): void { this.editor.setText(text); this.tui.requestRender(); }
  showHistory(): void {
    this.anchor = undefined;
    this.scroll.restoreTop = 0;
    this.scroll.scrollTo(0, { disableFollow: true });
    this.tui.requestRender();
  }

  private rememberAnchor(): void {
    if (this.scroll.isFollowingEnd) return;
    const row = this.rows.find(row => row.bottom > this.scroll.scrollTop);
    if (row) this.anchor = { id: row.id, offset: this.scroll.scrollTop - row.top, top: this.scroll.scrollTop };
  }

  update(state: ChatUIState): void {
    const previous = this.state.snapshot?.chat.id, next = state.snapshot?.chat.id;
    if (previous !== next) {
      if (previous) this.views.set(previous, { top: this.scroll.scrollTop, following: this.scroll.isFollowingEnd,
        expanded: this.expanded, tools: this.toolIds, expandNew: this.expandNew });
      const view = next ? this.views.get(next) : undefined;
      this.expanded = view?.expanded ?? new Set();
      this.expandNew = view?.expandNew ?? false;
      this.toolIds = view?.tools ?? new Set();
      this.prose.clear();
      this.anchor = undefined;
      this.rows = [];
      this.scroll.restoreTop = view && !view.following ? view.top : undefined;
      if (this.scroll.restoreTop === undefined) this.scroll.scrollToEnd();
      this.tui.resetTextSelection();
    } else this.rememberAnchor();
    for (const tool of state.snapshot?.toolCalls ?? []) {
      if (this.expandNew && !this.toolIds.has(tool.id)) this.expanded.add(tool.id);
    }
    this.toolIds = new Set(state.snapshot?.toolCalls?.map(tool => tool.id));
    this.state = { ...state };
    this.tui.requestRender();
  }

  private markdown(id: string, text: string, width: number): string[] {
    let block = this.prose.get(id);
    if (!block) {
      block = new Markdown("", 0, 0, markdownTheme, undefined, { renderLatex: false, preserveBackslashEscapes: true });
      this.prose.set(id, block);
    }
    block.setText(terminalText(text));
    return block.render(Math.max(1, width));
  }

  private renderHeader(width: number): string[] {
    const chat = this.state.snapshot?.chat;
    return [fit(bold(`Dispatch${chat ? ` · ${oneLine(chat.agent)}` : ""}`), width),
      fit(muted(chat ? `${oneLine(chat.title)} · ${oneLine(chat.id)}` : "Shared host conversations"), width), ""];
  }

  private renderTranscript(width: number): string[] {
    const snapshot = this.state.snapshot;
    this.rows = [];
    this.toolHits.clear();
    if (!snapshot) return [muted(this.state.connection === "connecting" ? "Connecting…" : "Choose a conversation with /chats or /agents."),
      ...this.state.notice ? wrapTextWithAnsi(warning(terminalText(this.state.notice)), Math.max(1, width)) : []].map(line => fit(line, width));
    const lines: string[] = [];
    const add = (id: string, content: string[]) => {
      const top = lines.length;
      lines.push(...content, "");
      this.rows.push({ id, top, bottom: lines.length });
    };
    const grouped = new Map<string, ChatToolCall[]>();
    const turns = new Map(snapshot.turns?.map(turn => [String(turn.entryId), turn]));
    for (const tool of snapshot.toolCalls ?? []) {
      const group = grouped.get(tool.afterMessageId) ?? [];
      group.push(tool);
      grouped.set(tool.afterMessageId, group);
    }
    const addTools = (tools: ChatToolCall[]) => {
      for (const tool of tools) {
        this.toolHits.set(lines.length, tool.id);
        const open = this.expanded.has(tool.id);
        const color = tool.status === "failed" ? failure : tool.status === "completed" ? success
          : ["cancelled", "unavailable"].includes(tool.status) ? warning : accent;
        const heading = fit(`${tool.parentCallId ? "  ↳ " : ""}${open ? "▾" : "▸"} ${bold(oneLine(tool.name))} ${color(tool.status)}`, width);
        const detail = open ? [
          ["Parent call", tool.parentCallId],
          ["Input", tool.input], ["Progress", tool.progress], ["Output", tool.output], ["Details", tool.details],
        ].flatMap(([label, value]) => value === undefined ? [] : [muted(String(label)),
          ...wrapTextWithAnsi(terminalText(outputText(value)), Math.max(1, width))]) : [];
        add(`tool:${tool.id}`, [heading, ...detail]);
      }
    };
    for (const message of snapshot.messages) {
      const turn = turns.get(message.id.split(":")[0]);
      const label = message.author ?? (message.role === "user"
        ? message.provenance === "agent" ? "Agent input" : message.provenance === "runtime" ? "Runtime" : "You"
        : snapshot.chat.agent);
      const heading = `${message.role === "user" ? "\x1b]133;A\x07" : ""}${accent(bold(oneLine(label)))}`
        + (message.background ? muted(" · background") : "")
        + (turn && turn.status !== "done" ? muted(` · ${turn.status}`) : "");
      const content = [fit(heading, width)];
      if (message.commentary && message.commentary !== message.text) content.push(...this.markdown(`${message.id}:commentary`, message.commentary, width));
      if (message.text) content.push(...this.markdown(message.id, message.text, width));
      if (message.details) content.push(...this.expandNew
        ? this.markdown(`${message.id}:details`, `${message.details.label}\n\n${message.details.text}`, width)
        : [fit(muted(`${oneLine(message.details.label)} · Ctrl+O to expand`), width)]);
      for (const file of [...message.attachments ?? [], ...message.artifacts ?? []])
        content.push(...wrapTextWithAnsi(muted(`Attachment · ${terminalText(file.name)}${"id" in file ? ` (${terminalText(file.id)})` : ""}`), Math.max(1, width)));
      if (message.error) content.push(...wrapTextWithAnsi(failure(terminalText(message.error)), Math.max(1, width)));
      if (turn?.status === "unanswered") content.push(fit(failure(`Not answered · ${oneLine(turn.reason ?? "unknown")}`), width));
      add(message.id, content);
      addTools(grouped.get(message.id) ?? []);
      grouped.delete(message.id);
    }
    for (const tools of grouped.values()) addTools(tools);
    if (snapshot.partial) add("partial", [accent(bold(oneLine(snapshot.chat.agent))), ...this.markdown("partial", snapshot.partial, width)]);
    for (const turn of snapshot.turns ?? []) if (turn.entryId === undefined && turn.status !== "done")
      add(`turn:${turn.submissionId}`, [fit(warning(`Input ${turn.submissionId} · ${turn.status}${turn.reason ? ` · ${oneLine(turn.reason)}` : ""}`), width)]);
    if (snapshot.retry) add("retry", wrapTextWithAnsi(warning(terminalText(
      `Retry ${snapshot.retry.attempt} at ${new Date(snapshot.retry.at).toLocaleTimeString()} · ${snapshot.retry.error}`)), Math.max(1, width)));
    if (snapshot.compactions?.length) add("compaction", [warning("Compacting context…")]);
    if (snapshot.compactionFailure) add("compaction-error", wrapTextWithAnsi(failure(
      terminalText(`Compaction failed · ${snapshot.compactionFailure.error}`)), Math.max(1, width)));
    if (snapshot.error && snapshot.error !== snapshot.retry?.error && snapshot.error !== snapshot.compactionFailure?.error)
      add("error", wrapTextWithAnsi(failure(terminalText(snapshot.error)), Math.max(1, width)));
    if (this.state.notice) add("notice", wrapTextWithAnsi(warning(terminalText(this.state.notice)), Math.max(1, width)));
    if (!lines.length) lines.push(muted("Start a conversation. /help shows commands."));
    if (this.anchor) {
      const row = this.rows.find(row => row.id === this.anchor!.id);
      if (row && !this.scroll.isFollowingEnd && this.scroll.scrollTop === this.anchor.top)
        this.scroll.restoreTop = row.top + this.anchor.offset;
      this.anchor = undefined;
    }
    return lines.map(line => fit(line, width));
  }

  private renderStatus(width: number): string[] {
    const { snapshot, connection, pending, notice } = this.state;
    const status = connection === "connecting" ? warning("◌ Connecting") : connection === "disconnected" ? failure("○ Disconnected")
      : snapshot?.running ? accent("● Working") : snapshot?.background ? accent("● Background activity")
        : snapshot?.queued ? warning("◷ Pending input") : success("● Ready");
    return [fit(status + (snapshot?.queued ? muted(` · ${snapshot.queued} queued`) : "")
      + (snapshot?.demo ? muted(" · demo") : ""), width),
    ...pending ? [fit(warning(oneLine(pending)), width)] : [],
    ...notice ? [fit(warning(oneLine(notice)), width)] : []];
  }

  showPicker(title: string, items: SelectItem[], onSelect: (value: string) => void, hints: string[] = []): void {
    this.overlay?.hide();
    const search = new Input({ prompt: "Search: ", placeholder: "type to filter" });
    const safeItems = items.map(item => ({ ...item, label: oneLine(item.label), description: item.description && oneLine(item.description) }));
    let height = 0, query = "";
    let list: SelectList;
    const close = () => { this.overlay?.hide(); this.overlay = undefined; this.tui.setFocus(this.editor); this.tui.requestRender(); };
    const updateList = () => {
      const available = Math.max(1, this.terminal.rows - 10 - hints.length);
      const filter = search.getValue().toLowerCase();
      if (height === available && query === filter) return;
      const selected = query === filter ? list?.getSelectedItem()?.value : undefined;
      const filtered = safeItems.filter(item => `${item.label} ${item.value} ${item.description ?? ""}`.toLowerCase().includes(filter));
      list = new SelectList(filtered, available, selectTheme);
      if (selected) list.setSelectedIndex(filtered.findIndex(item => item.value === selected));
      list.onCancel = close;
      list.onSelect = item => { close(); onSelect(item.value); };
      height = available;
      query = filter;
    };
    const picker: Component & { focused: boolean } = {
      focused: true, capturesViewportInput: true, invalidate() {},
      render: width => {
        updateList();
        search.focused = picker.focused;
        const inner = Math.max(1, width - 4);
        const content = [bold(oneLine(title)), ...search.render(inner), "", ...list.render(inner), "",
          muted("↑↓ choose · Enter select · Esc back"), ...hints.map(muted)];
        return [accent("┌" + "─".repeat(Math.max(0, width - 2)) + "┐"),
          ...content.map(line => {
            const clipped = fit(line, inner);
            return accent("│ ") + clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped))) + accent(" │");
          }), accent("└" + "─".repeat(Math.max(0, width - 2)) + "┘")];
      },
      handleInput: data => {
        updateList();
        if ((["up", "down", "pageUp", "pageDown", "enter", "escape", "ctrl+c"] as const).some(key => matchesKey(data, key))) list?.handleInput(data);
        else { search.handleInput(data); updateList(); }
        this.tui.requestRender();
      },
    };
    this.overlay = this.tui.showOverlay(picker, { width: "90%", maxHeight: "100%" });
  }

  showHelp(): void {
    this.showPicker("Commands", commands, this.onSubmit, [
      "Alt+Enter / Ctrl+J newline · ↑↓ input history",
      "Ctrl+P chats · Ctrl+G agents · Ctrl+O tool details",
      "PgUp/PgDn scroll · Ctrl+Home/End top/latest",
      "Ctrl+C clear, then exit · Ctrl+D empty exit",
      "F1 commands · Ctrl+Shift+F search · Esc close menu",
    ]);
  }
}
