import { Tabs } from "@base-ui/react/tabs";
import { Bot, ChevronLeft, ChevronRight, CircleHelp, LogOut, Menu, MessageSquare, PanelRight, Plus, Search, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { AgentDefinition, ApplicationConfig, ChatSnapshot, ChatSummary, CreateChatInput, SendMessageInput } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { mergeChat, statusLabels, type ConnectionState, type PendingMessage } from "../lib/chat";
import { useSession } from "../lib/session";
import { AgentsPage } from "./agents";
import { Brand } from "./brand";
import { ChatPanel } from "./chat";
import { ContextPanel } from "./context-panel";
import { SecurityPage } from "./security";
import { Button, IconButton, Modal, Notice, Spinner } from "./ui";

type WorkspaceTab = { id: string; kind: "chat"; chatId: string } | { id: string; kind: "welcome" | "agents" | "security" };
const welcomeTab: WorkspaceTab = { id: "welcome", kind: "welcome" };

export function Workspace() {
  const { state, api, auth, setState } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const [config, setConfig] = useState<ApplicationConfig | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => {
    const chatId = searchParams.get("chat");
    return chatId ? [{ id: `chat:${chatId}`, kind: "chat", chatId }] : [welcomeTab];
  });
  const [activeId, setActiveId] = useState(() => searchParams.get("chat") ? `chat:${searchParams.get("chat")}` : "welcome");
  const [snapshots, setSnapshots] = useState<Record<string, ChatSnapshot>>({});
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [pending, setPending] = useState<Record<string, PendingMessage | undefined>>({});
  const draftVersions = useRef<Record<string, number>>({});
  const messageRequests = useRef<Record<string, { requestId: string; draftVersion: number } | undefined>>({});
  const [sendErrors, setSendErrors] = useState<Record<string, string | undefined>>({});
  const [supportTabs, setSupportTabs] = useState<Record<string, string>>({});
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [agentDirty, setAgentDirty] = useState(false);
  const [securityDirty, setSecurityDirty] = useState(false);
  const [search, setSearch] = useState("");
  const [startingAgentId, setStartingAgentId] = useState<string | null>(null);
  const [closingTab, setClosingTab] = useState<string | null>(null);
  const tabList = useRef<HTMLDivElement>(null);
  const [tabOverflow, setTabOverflow] = useState({ before: false, after: false });

  const updateTabOverflow = useCallback(() => {
    const list = tabList.current;
    if (list) setTabOverflow({ before: list.scrollLeft > 1, after: list.scrollLeft + list.clientWidth < list.scrollWidth - 1 });
  }, []);

  useEffect(() => {
    const list = tabList.current;
    if (!list) return;
    const reveal = () => {
      list.querySelector<HTMLElement>('[aria-selected="true"]')?.parentElement?.scrollIntoView({ block: "nearest", inline: "nearest" });
      updateTabOverflow();
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [activeId, tabs, loading, updateTabOverflow]);
  const createRequest = useRef<CreateChatInput | null>(null);
  const [createFailed, setCreateFailed] = useState(false);

  const load = useCallback(async () => {
    try {
      const [nextConfig, chatResult, agentResult] = await Promise.all([
        api<ApplicationConfig>("/api/config"), api<{ chats: ChatSummary[] }>("/api/chats"), api<{ agents: AgentDefinition[] }>("/api/agents"),
      ]);
      setConfig(nextConfig);
      setChats(current => chatResult.chats.reduce(mergeChat, current));
      setAgents(agentResult.agents);
      setError(null);
    } catch (error) { setError(errorMessage(error)); } finally { setLoading(false); }
  }, [api]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const navigation = window.matchMedia("(max-width: 1100px)");
    const context = window.matchMedia("(max-width: 800px)");
    const closeWidePanels = () => {
      if (!navigation.matches) setNavigationOpen(false);
      if (!context.matches) setContextOpen(false);
    };
    navigation.addEventListener("change", closeWidePanels);
    context.addEventListener("change", closeWidePanels);
    return () => {
      navigation.removeEventListener("change", closeWidePanels);
      context.removeEventListener("change", closeWidePanels);
    };
  }, []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [load]);

  const hasRunningChats = chats.some(chat => chat.status === "running");
  useEffect(() => {
    if (!hasRunningChats) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void api<{ chats: ChatSummary[] }>("/api/chats").then(result => setChats(current => result.chats.reduce(mergeChat, current))).catch(() => { });
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [hasRunningChats, api]);

  const onSnapshot = useCallback((snapshot: ChatSnapshot) => {
    setSnapshots(current => current[snapshot.conversation.id]?.conversation.revision > snapshot.conversation.revision
      ? current : { ...current, [snapshot.conversation.id]: snapshot });
    setChats(current => mergeChat(current, snapshot.conversation));
  }, []);
  const onConnection = useCallback((chatId: string, connection: ConnectionState) => setConnections(current => ({ ...current, [chatId]: connection })), []);

  const settleMessage = useCallback((chatId: string, requestId: string) => {
    const request = messageRequests.current[chatId];
    if (request?.requestId !== requestId) return;
    messageRequests.current[chatId] = undefined;
    setPending(current => current[chatId]?.requestId === requestId ? { ...current, [chatId]: undefined } : current);
    // A later draft can have identical text; only the submitted edit may be cleared.
    if ((draftVersions.current[chatId] ?? 0) === request.draftVersion) {
      setDrafts(current => ({ ...current, [chatId]: "" }));
    }
    setSendErrors(current => ({ ...current, [chatId]: undefined }));
  }, []);

  useEffect(() => {
    for (const [chatId, message] of Object.entries(pending)) {
      if (message && snapshots[chatId]?.submissions.some(submission => submission.requestId === message.requestId)) {
        settleMessage(chatId, message.requestId);
      }
    }
  }, [pending, snapshots, settleMessage]);

  function activate(tab: WorkspaceTab) {
    setTabs(current => current.some(item => item.id === tab.id) ? current : [...current.filter(item => item.kind !== "welcome"), tab]);
    if (tab.kind === "chat" && tab.id !== activeId) setConnections(current => ({ ...current, [tab.chatId]: "connecting" }));
    setActiveId(tab.id);
    setNavigationOpen(false);
    setSearchParams(tab.kind === "chat" ? { chat: tab.chatId } : {}, { replace: true });
  }

  function requestCloseTab(tabId: string) {
    const tab = tabs.find(item => item.id === tabId);
    const dirty = tab?.kind === "chat" ? !!drafts[tab.chatId]?.trim() || !!pending[tab.chatId]
      : tab?.kind === "agents" ? agentDirty : tab?.kind === "security" ? securityDirty : false;
    if (dirty) setClosingTab(tabId);
    else closeTab(tabId);
  }

  function closeTab(tabId: string) {
    const closing = tabs.find(tab => tab.id === tabId);
    if (closing?.kind === "chat") {
      messageRequests.current[closing.chatId] = undefined;
      draftVersions.current[closing.chatId] = (draftVersions.current[closing.chatId] ?? 0) + 1;
      setSendErrors(current => ({ ...current, [closing.chatId]: undefined }));
      setDrafts(current => ({ ...current, [closing.chatId]: "" }));
      setPending(current => ({ ...current, [closing.chatId]: undefined }));
    }
    if (closing?.kind === "agents") setAgentDirty(false);
    if (closing?.kind === "security") setSecurityDirty(false);
    setClosingTab(null);
    const remaining = tabs.filter(tab => tab.id !== tabId);
    const next = remaining.length ? remaining : [welcomeTab];
    setTabs(next);
    let focusId = activeId;
    if (activeId === tabId) {
      const selected = next[Math.max(0, Math.min(tabs.findIndex(tab => tab.id === tabId) - 1, next.length - 1))];
      focusId = selected.id;
      setActiveId(selected.id);
      setSearchParams(selected.kind === "chat" ? { chat: selected.chatId } : {}, { replace: true });
    }
    requestAnimationFrame(() => {
      (tabList.current?.querySelector<HTMLElement>(`[data-work-tab="${CSS.escape(focusId)}"]`) ?? document.getElementById("main-workspace"))?.focus();
    });
  }

  async function createChat(agentId = config?.defaultAgentId) {
    if (creating || !agentId) return;
    const sameRequest = createRequest.current?.agentDefinitionId === agentId;
    if (!sameRequest) createRequest.current = { requestId: crypto.randomUUID(), agentDefinitionId: agentId };
    setCreating(true); setError(null); setCreateFailed(false);
    try {
      const snapshot = await api<ChatSnapshot>("/api/chats", createRequest.current);
      onSnapshot(snapshot);
      createRequest.current = null;
      activate({ id: `chat:${snapshot.conversation.id}`, kind: "chat", chatId: snapshot.conversation.id });
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) createRequest.current = null;
      else setCreateFailed(true);
    } finally { setCreating(false); }
  }

  async function sendMessage(chatId: string) {
    if (pending[chatId]?.sending) return;
    const previous = pending[chatId];
    const text = previous?.text || drafts[chatId]?.trim();
    if (!text) return;
    const command: SendMessageInput = { requestId: previous?.requestId || crypto.randomUUID(), text };
    const priorRequest = messageRequests.current[chatId];
    messageRequests.current[chatId] = priorRequest?.requestId === command.requestId
      ? priorRequest : { requestId: command.requestId, draftVersion: draftVersions.current[chatId] ?? 0 };
    setPending(current => ({ ...current, [chatId]: { ...command, sending: true } }));
    setSendErrors(current => ({ ...current, [chatId]: undefined }));
    try {
      const snapshot = await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(chatId)}/messages`, command);
      onSnapshot(snapshot);
      settleMessage(chatId, command.requestId);
    } catch (error) {
      if (messageRequests.current[chatId]?.requestId !== command.requestId) return;
      const message = errorMessage(error);
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
        messageRequests.current[chatId] = undefined;
        setPending(current => current[chatId]?.requestId === command.requestId ? { ...current, [chatId]: undefined } : current);
        setSendErrors(current => ({ ...current, [chatId]: message }));
      } else {
        setPending(current => current[chatId]?.requestId === command.requestId ? { ...current, [chatId]: { ...command, sending: false, error: message } } : current);
      }
    }
  }

  async function signOut() {
    setSigningOut(true); setError(null);
    try { setState(await auth("/api/auth/logout", {})); } catch (error) { setError(errorMessage(error)); } finally { setSigningOut(false); }
  }

  function updateAgent(agent: AgentDefinition) { setAgents(current => [agent, ...current.filter(item => item.id !== agent.id)].sort((a, b) => a.name.localeCompare(b.name))); }

  const active = tabs.find(tab => tab.id === activeId) || welcomeTab;
  const snapshot = active.kind === "chat" ? snapshots[active.chatId] : undefined;
  const connection = active.kind === "chat" ? connections[active.chatId] || "connecting" : null;
  const supporting = <ContextPanel kind={active.kind} snapshot={snapshot} tab={supportTabs[active.id] || "agent"} onTabChange={tab => setSupportTabs(current => ({ ...current, [active.id]: tab }))} />;
  const chatNav = () => {
    const existing = [...tabs].reverse().find(tab => tab.kind === "chat");
    activate(existing || welcomeTab);
  };
  const sidebar = <ConversationSidebar chats={chats} activeChatId={active.kind === "chat" ? active.chatId : undefined} companyName={config?.company.name || "Workspace"} search={search} onSearchChange={setSearch} creating={creating} onSelect={chatId => activate({ id: `chat:${chatId}`, kind: "chat", chatId })} onCreate={() => void createChat()} />;

  if (state?.state !== "authenticated") return null;
  if (loading) return <main className="page-loading">
    <Brand />
    <p>
      <Spinner /> Opening your workspace…</p>
  </main>;
  if (!config) return <main className="page-loading">
    <Brand />
    <Notice>{error || "The workspace could not be loaded."}</Notice>
    <Button onClick={() => { setLoading(true); void load(); }}>Try again</Button>
    <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
  </main>;

  return <div className="workspace">
    <a className="skip-link" href="#main-workspace">Skip to main content</a>
    <nav className="workspace-rail" aria-label="Workspace navigation">
      <div className="rail-brand">
        <Brand compact />
      </div>
      <div className="rail-links">
        <IconButton label="Chats" className={active.kind === "chat" || active.kind === "welcome" ? "active" : ""} aria-current={active.kind === "chat" || active.kind === "welcome" ? "page" : undefined} onClick={chatNav}>
          <MessageSquare size={21} />
        </IconButton>
        <IconButton label="Agents" className={active.kind === "agents" ? "active" : ""} aria-current={active.kind === "agents" ? "page" : undefined} onClick={() => activate({ id: "agents", kind: "agents" })}>
          <Bot size={21} />
        </IconButton>
      </div>
      <div className="rail-account">
        <IconButton label="Account and security" className={active.kind === "security" ? "active" : ""} aria-current={active.kind === "security" ? "page" : undefined} onClick={() => activate({ id: "security", kind: "security" })}>
          <Settings2 size={20} />
        </IconButton>
        <IconButton label="Sign out" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? <Spinner /> : <LogOut size={19} />}</IconButton>
        <span className="rail-avatar" title={state.user.name}>{state.user.name.slice(0, 1).toUpperCase()}
        </span>
      </div>
    </nav>
    <aside className="workspace-sidebar" aria-label="Conversations">{sidebar}</aside>
    <Tabs.Root className="workspace-content" value={activeId} onValueChange={value => { const tab = tabs.find(tab => tab.id === value); if (tab) activate(tab); }}>
      <div className="main-column">
        <header className={`workspace-toolbar ${tabs.length > 1 ? "has-tabs" : "single-view"}`}>
          <div className="mobile-navigation">
            <Modal title="Your workspace" description={config.company.name} side="left" open={navigationOpen} onOpenChange={setNavigationOpen} trigger={<Button variant="ghost" className="workspace-action">
              <Menu size={21} /> Menu</Button>}>
              <nav className="mobile-destinations" aria-label="Workspace navigation">
                <Button variant="ghost" aria-current={active.kind === "chat" || active.kind === "welcome" ? "page" : undefined} onClick={chatNav}>
                  <MessageSquare /> Chats</Button>
                <Button variant="ghost" aria-current={active.kind === "agents" ? "page" : undefined} onClick={() => activate({ id: "agents", kind: "agents" })}>
                  <Bot /> Agents</Button>
                <Button variant="ghost" aria-current={active.kind === "security" ? "page" : undefined} onClick={() => activate({ id: "security", kind: "security" })}>
                  <Settings2 /> Account</Button>
              </nav>{sidebar}<Button className="mobile-signout" variant="ghost" onClick={() => void signOut()} disabled={signingOut}>
                <LogOut /> Sign out</Button>
            </Modal>
          </div>
          {tabs.length > 1 ? <>
            <p id="tab-keyboard-help" className="sr-only">Use arrow keys to choose a tab, Enter to open it, and Delete to close it.</p>
            <div className="tabs-strip">
              {tabOverflow.before || tabOverflow.after ? <IconButton disabled={!tabOverflow.before} className="tab-scroll-button" label="Show earlier tabs" onClick={() => tabList.current?.scrollBy({ left: -200, behavior: "smooth" })}>
                <ChevronLeft />
              </IconButton> : null}
              <Tabs.List ref={tabList} className="main-tabs" aria-label="Open work" aria-describedby="tab-keyboard-help" activateOnFocus={false} onScroll={updateTabOverflow}>
                {tabs.map(tab => {
                  const title = tab.kind === "chat" ? chats.find(chat => chat.id === tab.chatId)?.title || "Conversation" : tab.kind === "agents" ? "Agents" : tab.kind === "security" ? "Account" : "Workspace";
                  return <div key={tab.id} role="presentation" className={`main-tab-item ${tab.id === activeId ? "selected" : ""}`}>
                    <Tabs.Tab value={tab.id} data-work-tab={tab.id} className="main-tab"
                      onKeyDown={event => {
                        if (event.key === "Delete" && tab.kind !== "welcome") {
                          event.preventDefault();
                          requestCloseTab(tab.id);
                        }
                      }}>
                      {tab.kind === "agents" ? <Bot size={15} /> : tab.kind === "security" ? <Settings2 size={15} /> : <MessageSquare size={14} />}
                      <span>{title}</span>
                    </Tabs.Tab>
                    {tab.kind !== "welcome" ? <IconButton className="tab-close" tabIndex={-1} label={`Close ${title} (Delete)`} onClick={() => requestCloseTab(tab.id)}>
                      <X size={16} />
                    </IconButton> : null}
                  </div>;
                })}
              </Tabs.List>
              {tabOverflow.before || tabOverflow.after ? <IconButton disabled={!tabOverflow.after} className="tab-scroll-button" label="Show later tabs" onClick={() => tabList.current?.scrollBy({ left: 200, behavior: "smooth" })}>
                <ChevronRight />
              </IconButton> : null}
            </div>
          </> : null}
          <Button variant="ghost" className="workspace-action" disabled={creating} onClick={() => void createChat()}>{creating ? <Spinner /> : <Plus size={18} />} New chat</Button>
          {active.kind !== "welcome" ? <div className="mobile-context">
            <Modal title={active.kind === "chat" ? "Conversation details" : "Details"} description={active.kind === "chat" ? snapshot?.conversation.title || "Active conversation" : "For your current tab"} side="right" open={contextOpen} onOpenChange={setContextOpen} trigger={<Button variant="ghost" className="workspace-action">
              <PanelRight size={19} /> Details</Button>}>{supporting}</Modal>
          </div> : null}
        </header>
        {error ? <div className="workspace-notice">
          <Notice>{error}</Notice>{createFailed ? <Button variant="secondary" disabled={creating} onClick={() => void createChat(createRequest.current?.agentDefinitionId)}>Retry creating chat</Button> : <Button variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}
        </div> : null}
        <main className="workspace-main" id="main-workspace" tabIndex={-1}>
          {tabs.map(tab => <Tabs.Panel key={tab.id} value={tab.id} className="main-tab-panel" role={tabs.length === 1 ? "region" : "tabpanel"} aria-label={tabs.length === 1 ? "Workspace content" : undefined} keepMounted>
            {tab.kind === "chat" ? <ChatPanel
              active={tab.id === activeId}
              connection={connections[tab.chatId] || "connecting"}
              chatId={tab.chatId}
              snapshot={snapshots[tab.chatId]}
              draft={drafts[tab.chatId] || ""}
              pending={pending[tab.chatId]}
              sendError={sendErrors[tab.chatId]}
              onDraftChange={text => {
                draftVersions.current[tab.chatId] = (draftVersions.current[tab.chatId] ?? 0) + 1;
                if (pending[tab.chatId] && !pending[tab.chatId]?.sending && pending[tab.chatId]?.text !== text.trim()) {
                  messageRequests.current[tab.chatId] = undefined;
                }
                setDrafts(current => ({ ...current, [tab.chatId]: text }));
                setSendErrors(current => ({ ...current, [tab.chatId]: undefined }));
                setPending(current => current[tab.chatId] && !current[tab.chatId]?.sending && current[tab.chatId]?.text !== text.trim()
                  ? { ...current, [tab.chatId]: undefined } : current);
              }}
              onSend={() => void sendMessage(tab.chatId)}
              onSnapshot={onSnapshot}
              onConnection={onConnection}
            /> : tab.kind === "agents" ? <AgentsPage
              onDirtyChange={setAgentDirty} agents={agents} config={config}
              onSaved={updateAgent} onRefresh={load}
              onStartChat={agentId => void createChat(agentId)} creating={creating}
            /> : tab.kind === "security" ? <SecurityPage onDirtyChange={setSecurityDirty} /> : <Welcome
              name={state.user.name} config={config} agents={agents}
              agentId={startingAgentId ?? config.defaultAgentId} onAgentChange={setStartingAgentId}
              onCreate={agentId => void createChat(agentId)} creating={creating}
            />}
          </Tabs.Panel>)}
        </main>
      </div>
      <aside className="context-column" aria-label={active.kind === "chat" ? `Supporting views for ${snapshot?.conversation.title || "active conversation"}` : "Supporting view"}>{supporting}</aside>
    </Tabs.Root>
    <Modal title="Discard unsaved work?" description="Closing this tab discards its unsaved input. Saved work and any running response remain available."
      finalFocus={() => tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? document.getElementById("main-workspace")}
      open={closingTab !== null} onOpenChange={open => { if (!open) setClosingTab(null); }}>
      <div className="button-row">
        <Button variant="secondary" onClick={() => setClosingTab(null)}>Keep tab open</Button>
        <Button variant="danger" onClick={() => { if (closingTab) closeTab(closingTab); }}>Discard and close</Button>
      </div>
    </Modal>
    <footer className="workspace-status">
      <span className={`connection-status connection-${connection || "unobserved"}`} role="status">
        <span aria-hidden="true" />{connection === "reconnecting" ? "Reconnecting · agent work continues" : connection === "connecting" ? "Connecting to conversation" : connection === "error" ? "Connection needs attention" : connection === "connected" ? "Conversation connected" : "No live conversation selected"}</span>
      <span className="status-company">{config.company.name}</span>
      <span className="status-user">{state.user.name}</span>
    </footer>
  </div>;
}

function ConversationSidebar({ chats, activeChatId, companyName, search, onSearchChange, creating, onSelect, onCreate }: { chats: ChatSummary[]; activeChatId?: string; companyName: string; search: string; onSearchChange: (value: string) => void; creating: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  const filtered = chats.filter(chat => chat.title.toLowerCase().includes(search.toLowerCase()));
  return <div className="conversation-sidebar">
    <header className="sidebar-brand">
      <Brand />{companyName.toLowerCase() !== "dispatch" ? <p>{companyName}</p> : null}
    </header>
    <Button className="new-chat-button" onClick={onCreate} disabled={creating}>{creating ? <Spinner /> : <Plus />} New chat</Button>
    <label className="conversation-search">
      <span className="sr-only">Find a conversation</span>
      <Search size={15} aria-hidden="true" />
      <input type="search" value={search} onChange={event => onSearchChange(event.target.value)} placeholder="Find a conversation" />
    </label>
    <div className="sidebar-list-heading">
      <h2>Conversations</h2>
      <span>{chats.length}</span>
    </div>
    <nav className="conversation-list" aria-label="Saved conversations">{filtered.map(chat => <button type="button" key={chat.id} onClick={() => onSelect(chat.id)} className={chat.id === activeChatId ? "selected" : ""} aria-current={chat.id === activeChatId ? "page" : undefined} title={chat.title}>
      <MessageSquare size={15} aria-hidden="true" />
      <span>{chat.title}</span>
      <span className={`conversation-dot dot-${chat.status}`} aria-label={statusLabels[chat.status]} />
    </button>)}{!filtered.length ? <p className="sidebar-empty">{search ? "No conversations match your search." : "Your conversations will appear here."}</p> : null}
    </nav>
  </div>;
}

function Welcome({ name, config, agents, agentId, onAgentChange, creating, onCreate }: {
  name: string; config: ApplicationConfig; agents: AgentDefinition[]; agentId: string;
  onAgentChange: (agentId: string) => void; creating: boolean; onCreate: (agentId: string) => void;
}) {
  return <section className="welcome-view">
    <span className="eyebrow">Hello, {name.split(" ")[0]}</span>
    <h1>Your workspace</h1>
    <p>A question, a plan, a problem to untangle.<br />Start a conversation and make some headway.</p>
    <div className="welcome-actions">
      <label htmlFor="starting-agent">Start with</label>
      <select className="control-select" id="starting-agent" value={agentId} onChange={event => onAgentChange(event.target.value)}>{agents.filter(agent => !agent.archived).map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}
      </select>
      <Button disabled={creating || !agentId} onClick={() => onCreate(agentId)}>{creating ? <Spinner /> : <Plus />} New chat</Button>
    </div>{!config.providerReady ? <Notice tone="info">The default agent is not connected yet. Choose another configured agent or ask your operator to connect it.</Notice> : null}
    <p className="welcome-footnote">
      <CircleHelp size={14} /> Each conversation starts fresh and keeps its own history.</p>
  </section>;
}
