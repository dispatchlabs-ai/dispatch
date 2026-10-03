import { Tabs } from "@base-ui/react/tabs";
import { Bot, ChevronLeft, ChevronRight, CircleHelp, LogOut, Menu, MessageSquare, PanelLeft, PanelRight, Plus, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import type { AgentDefinition, ApplicationConfig, ChatSnapshot, ChatSummary, CreateChatInput, SendMessageInput } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { mergeChat, type ConnectionState, type PendingMessage } from "../lib/chat";
import { useSession } from "../lib/session";
import { AgentArchiveDialog, AgentDetails, AgentsPage, type AgentEditing } from "./agents";
import { AgentSidebar } from "./agent-sidebar";
import { Brand } from "./brand";
import { ChatPanel } from "./chat";
import { ConversationSidebar } from "./conversation-sidebar";
import { ColumnResizeHandle } from "./column-resize-handle";
import { ContextPanel } from "./context-panel";
import { SecurityPage } from "./security";
import { Button, IconButton, Modal, Notice, Spinner } from "./ui";

type WorkspaceTab = { id: string; kind: "chat"; chatId: string } | { id: string; kind: "welcome" };
type WorkspaceSection = "chats" | "agents" | "security";
const welcomeTab: WorkspaceTab = { id: "welcome", kind: "welcome" };

export function Workspace() {
  const { state, api, auth, setState } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const [section, setSection] = useState<WorkspaceSection>("chats");
  const [visited, setVisited] = useState({ agents: false, security: false });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [editingAgent, setEditingAgent] = useState<AgentEditing>(null);
  const [archivingAgent, setArchivingAgent] = useState<AgentDefinition | null>(null);
  const [agentSearch, setAgentSearch] = useState("");
  const [showArchivedAgents, setShowArchivedAgents] = useState(false);
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
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [detailsVisible, setDetailsVisible] = useState(true);
  const [preferredSidebarWidth, setSidebarWidth] = useState(244);
  const [preferredDetailsWidth, setDetailsWidth] = useState(294);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1440 : window.innerWidth);
  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);
  const sidebarMax = Math.max(200, Math.min(420, Math.floor(viewportWidth * .25)));
  const detailsMax = Math.max(240, Math.min(480, Math.floor(viewportWidth * .3)));
  const sidebarWidth = Math.min(preferredSidebarWidth, sidebarMax);
  const detailsWidth = Math.min(preferredDetailsWidth, detailsMax);
  const [creating, setCreating] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
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
  }, [activeId, tabs, section, loading, updateTabOverflow]);
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

  function selectSection(next: WorkspaceSection) {
    setSection(next);
    if (next !== "chats") setVisited(current => ({ ...current, [next]: true }));
    setNavigationOpen(false);
    setContextOpen(false);
  }

  function activate(tab: WorkspaceTab) {
    selectSection("chats");
    setTabs(current => current.some(item => item.id === tab.id) ? current : [...current.filter(item => item.kind !== "welcome"), tab]);
    if (tab.kind === "chat" && tab.id !== activeId) setConnections(current => ({ ...current, [tab.chatId]: "connecting" }));
    setActiveId(tab.id);
    setNavigationOpen(false);
    setSearchParams(tab.kind === "chat" ? { chat: tab.chatId } : {}, { replace: true });
  }

  function requestCloseTab(tabId: string) {
    const tab = tabs.find(item => item.id === tabId);
    const dirty = tab?.kind === "chat" ? !!drafts[tab.chatId]?.trim() || !!pending[tab.chatId] : false;
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

  const selectedAgent = agents.find(agent => agent.id === selectedAgentId) ?? agents.find(agent => agent.id === config?.defaultAgentId);
  const active: WorkspaceTab | { id: string; kind: "agents" | "security" } = section === "chats" ? tabs.find(tab => tab.id === activeId) || welcomeTab : { id: section, kind: section };
  const snapshot = active.kind === "chat" ? snapshots[active.chatId] : undefined;
  const connection = active.kind === "chat" ? connections[active.chatId] || "connecting" : null;
  const supporting = section === "agents" ? <AgentDetails agent={selectedAgent} editing={editingAgent} /> : <ContextPanel kind={active.kind} snapshot={snapshot} tab={supportTabs[active.id] || "agent"} onTabChange={tab => setSupportTabs(current => ({ ...current, [active.id]: tab }))} />;
  const chatNav = () => selectSection("chats");
  const conversations = <ConversationSidebar chats={chats} activeChatId={active.kind === "chat" ? active.chatId : undefined} search={search} onSearchChange={setSearch} creating={creating} onSelect={chatId => activate({ id: `chat:${chatId}`, kind: "chat", chatId })} onCreate={() => void createChat()} onUpdate={async (id, input) => onSnapshot(await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(id)}/preferences`, input))} />;
  const sidebar = <>
    <div className="section-sidebar-panel" hidden={section !== "chats"}>{conversations}</div>
    <div className="section-sidebar-panel" hidden={section !== "agents"}>
      <AgentSidebar agents={agents} defaultAgentId={config?.defaultAgentId}
        selectedAgentId={editingAgent && editingAgent !== "new" ? editingAgent.id : selectedAgent?.id}
        editing={editingAgent === "new" ? "new" : !!editingAgent}
        search={agentSearch} onSearchChange={setAgentSearch} showArchived={showArchivedAgents} onShowArchivedChange={setShowArchivedAgents}
        onCreate={() => { setEditingAgent("new"); setAgentSearch(""); setShowArchivedAgents(false); setNavigationOpen(false); }}
        onSelect={id => { setSelectedAgentId(id); setNavigationOpen(false); }}
        onEdit={agent => { setSelectedAgentId(agent.id); setEditingAgent(agent); setNavigationOpen(false); }}
        onArchive={agent => { setArchivingAgent(agent); setNavigationOpen(false); }} />
    </div>
    {section === "security" ? <div className="section-sidebar">
      <h2>Account</h2>
      <nav aria-label="Account settings">
        {[['passkeys', 'Passkeys'], ['password', 'Password & authenticator'], ['sessions', 'Active sessions']].map(([id, label]) => <Button key={id} variant="ghost" onClick={() => {
          setNavigationOpen(false);
          requestAnimationFrame(() => document.getElementById(`account-${id}`)?.scrollIntoView({ block: "start" }));
        }}>{label}</Button>)}
      </nav>
    </div> : null}
  </>;

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

  return <div className={`workspace ${sidebarVisible ? "" : "sidebar-hidden"} ${detailsVisible ? "" : "details-hidden"}`}
    style={{ "--sidebar-width": `${sidebarVisible ? sidebarWidth : 0}px`, "--details-width": `${detailsVisible ? detailsWidth : 0}px` } as CSSProperties}>
    <a className="skip-link" href="#main-workspace">Skip to main content</a>
    <nav className="workspace-rail" aria-label="Workspace navigation">
      <div className="rail-brand">
        <Brand compact />
      </div>
      <div className="rail-links">
        <IconButton label="Chats" className={active.kind === "chat" || active.kind === "welcome" ? "active" : ""} aria-current={active.kind === "chat" || active.kind === "welcome" ? "page" : undefined} onClick={chatNav}>
          <MessageSquare size={21} />
        </IconButton>
        <IconButton label="Agents" className={active.kind === "agents" ? "active" : ""} aria-current={active.kind === "agents" ? "page" : undefined} onClick={() => selectSection("agents")}>
          <Bot size={21} />
        </IconButton>
      </div>
      <div className="rail-layout" role="group" aria-label="Workspace columns">
        <IconButton className="sidebar-toggle" label={sidebarVisible ? "Hide sidebar" : "Show sidebar"} aria-expanded={sidebarVisible} aria-controls="workspace-sidebar" onClick={() => setSidebarVisible(value => !value)}>
          <PanelLeft size={19} />
        </IconButton>
        <IconButton className="details-toggle" label={detailsVisible ? "Hide details" : "Show details"} aria-expanded={detailsVisible} aria-controls="details-column" onClick={() => setDetailsVisible(value => !value)}>
          <PanelRight size={19} />
        </IconButton>
      </div>
      <div className="rail-account">
        <IconButton label="Account and security" className={active.kind === "security" ? "active" : ""} aria-current={active.kind === "security" ? "page" : undefined} onClick={() => selectSection("security")}>
          <Settings2 size={20} />
        </IconButton>
        <IconButton label="Sign out" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? <Spinner /> : <LogOut size={19} />}</IconButton>
        <span className="rail-avatar" title={state.user.name}>{state.user.name.slice(0, 1).toUpperCase()}
        </span>
      </div>
    </nav>
    <aside className="workspace-sidebar" id="workspace-sidebar" aria-label={section === "chats" ? "Conversations" : section === "agents" ? "Agents" : "Account"}>
      {sidebar}
      <ColumnResizeHandle side="left" controls="workspace-sidebar" width={sidebarWidth} min={200} max={sidebarMax} onResize={setSidebarWidth} />
    </aside>
    <Tabs.Root className="workspace-content" value={activeId} onValueChange={value => { const tab = tabs.find(tab => tab.id === value); if (tab) activate(tab); }}>
      <div className="main-column">
        {section === "chats" && tabs.length > 1 ? <header className="workspace-toolbar">
            <p id="tab-keyboard-help" className="sr-only">Use arrow keys to choose a tab, Enter to open it, and Delete to close it.</p>
            <div className="tabs-strip">
              {tabOverflow.before || tabOverflow.after ? <IconButton disabled={!tabOverflow.before} className="tab-scroll-button" label="Show earlier tabs" onClick={() => tabList.current?.scrollBy({ left: -200, behavior: "smooth" })}>
                <ChevronLeft />
              </IconButton> : null}
              <Tabs.List ref={tabList} className="main-tabs" aria-label="Open work" aria-describedby="tab-keyboard-help" activateOnFocus={false} onScroll={updateTabOverflow}>
                {tabs.map(tab => {
                  const title = tab.kind === "chat" ? chats.find(chat => chat.id === tab.chatId)?.title || "Conversation" : "Workspace";
                  return <div key={tab.id} role="presentation" className={`main-tab-item ${tab.id === activeId ? "selected" : ""}`}>
                    <Tabs.Tab value={tab.id} data-work-tab={tab.id} className="main-tab"
                      onKeyDown={event => {
                        if (event.key === "Delete" && tab.kind !== "welcome") {
                          event.preventDefault();
                          requestCloseTab(tab.id);
                        }
                      }}>
                      <MessageSquare size={14} />
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
        </header> : null}
        {error ? <div className="workspace-notice">
          <Notice>{error}</Notice>{createFailed ? <Button variant="secondary" disabled={creating} onClick={() => void createChat(createRequest.current?.agentDefinitionId)}>Retry creating chat</Button> : <Button variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}
        </div> : null}
        <main className="workspace-main" id="main-workspace" tabIndex={-1}>
          <div className="workspace-section" hidden={section !== "chats"}>
          {tabs.map(tab => <Tabs.Panel key={tab.id} value={tab.id} className="main-tab-panel" role={tabs.length === 1 ? "region" : "tabpanel"} aria-label={tabs.length === 1 ? "Workspace content" : undefined} keepMounted>
            {tab.kind === "chat" ? <ChatPanel
              active={section === "chats" && tab.id === activeId}
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
            /> : <Welcome
              name={state.user.name} config={config} agents={agents}
              agentId={startingAgentId ?? config.defaultAgentId} onAgentChange={setStartingAgentId}
              onCreate={agentId => void createChat(agentId)} creating={creating}
            />}
          </Tabs.Panel>)}
          </div>
          {visited.agents ? <div className="workspace-section" hidden={section !== "agents"}>
            <AgentsPage agent={selectedAgent} editing={editingAgent} config={config} defaultAgent={agents.find(agent => agent.id === config.defaultAgentId)}
              onSaved={agent => { updateAgent(agent); setSelectedAgentId(agent.id); setEditingAgent(null); }}
              onCancel={() => { setEditingAgent(null); void load(); }} onEdit={setEditingAgent}
              onStartChat={agentId => void createChat(agentId)} creating={creating} />
          </div> : null}
          {visited.security ? <div className="workspace-section" hidden={section !== "security"}><SecurityPage /></div> : null}
        </main>
      </div>
      <aside className="context-column" id="details-column" aria-label={active.kind === "chat" ? `Supporting views for ${snapshot?.conversation.title || "active conversation"}` : section === "agents" ? "Agent supporting view" : "Supporting view"}>
        <ColumnResizeHandle side="right" controls="details-column" width={detailsWidth} min={240} max={detailsMax} onResize={setDetailsWidth} />
        <div className="context-column-content">{supporting}</div>
      </aside>
    </Tabs.Root>
    {archivingAgent ? <AgentArchiveDialog key={archivingAgent.id} agent={archivingAgent} onClose={() => setArchivingAgent(null)} onSaved={updateAgent} onRefresh={load} /> : null}
    <Modal title="Discard unsaved work?" description="Closing this tab discards its unsaved input. Saved work and any running response remain available."
      finalFocus={() => tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]') ?? document.getElementById("main-workspace")}
      open={closingTab !== null} onOpenChange={open => { if (!open) setClosingTab(null); }}>
      <div className="button-row">
        <Button variant="secondary" onClick={() => setClosingTab(null)}>Keep tab open</Button>
        <Button variant="danger" onClick={() => { if (closingTab) closeTab(closingTab); }}>Discard and close</Button>
      </div>
    </Modal>
    <footer className="workspace-status">
      <div className="mobile-workspace-actions">
        <div className="mobile-navigation">
          <Modal title="Your workspace" description={config.company.name} side="left" open={navigationOpen} onOpenChange={setNavigationOpen} trigger={<Button variant="ghost" className="workspace-action">
            <Menu size={21} /> Menu</Button>}>
            <nav className="mobile-destinations" aria-label="Workspace navigation">
              <Button variant="ghost" aria-current={active.kind === "chat" || active.kind === "welcome" ? "page" : undefined} onClick={chatNav}>
                <MessageSquare /> Chats</Button>
              <Button variant="ghost" aria-current={active.kind === "agents" ? "page" : undefined} onClick={() => selectSection("agents")}>
                <Bot /> Agents</Button>
              <Button variant="ghost" aria-current={active.kind === "security" ? "page" : undefined} onClick={() => selectSection("security")}>
                <Settings2 /> Account</Button>
            </nav>{sidebar}<Button className="mobile-signout" variant="ghost" onClick={() => void signOut()} disabled={signingOut}>
              <LogOut /> Sign out</Button>
          </Modal>
        </div>
        {active.kind !== "welcome" ? <div className="mobile-context">
          <Modal title={active.kind === "chat" ? "Conversation details" : section === "agents" ? "Agent details" : "Details"} description={active.kind === "chat" ? snapshot?.conversation.title || "Active conversation" : "For your current view"} side="right" open={contextOpen} onOpenChange={setContextOpen} trigger={<Button variant="ghost" className="workspace-action">
            <PanelRight size={19} /> Details</Button>}>{supporting}</Modal>
        </div> : null}
      </div>
      <span className={`connection-status connection-${connection || "unobserved"}`} role="status">
        <span aria-hidden="true" />{connection === "reconnecting" ? "Reconnecting · agent work continues" : connection === "connecting" ? "Connecting to conversation" : connection === "error" ? "Connection needs attention" : connection === "connected" ? "Conversation connected" : "No live conversation selected"}</span>
      <span className="status-company">{config.company.name}</span>
      <span className="status-user">{state.user.name}</span>
    </footer>
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
