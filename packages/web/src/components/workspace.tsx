import { Tabs } from "@base-ui/react/tabs";
import { Bot, CircleHelp, LogOut, Menu, MessageSquare, PanelRight, Plus, Search, Settings2, X } from "lucide-react";
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
  const [sendErrors, setSendErrors] = useState<Record<string, string | undefined>>({});
  const [supportTabs, setSupportTabs] = useState<Record<string, string>>({});
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
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
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", refresh);
    return () => document.removeEventListener("visibilitychange", refresh);
  }, [load]);

  const hasRunningChats = chats.some(chat => chat.status === "running");
  useEffect(() => {
    if (!hasRunningChats) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void api<{ chats: ChatSummary[] }>("/api/chats").then(result => setChats(current => result.chats.reduce(mergeChat, current))).catch(() => {});
    }, 15_000);
    return () => window.clearInterval(timer);
  }, [hasRunningChats, api]);

  const onSnapshot = useCallback((snapshot: ChatSnapshot) => {
    setSnapshots(current => ({ ...current, [snapshot.conversation.id]: snapshot }));
    setChats(current => mergeChat(current, snapshot.conversation));
  }, []);
  const onConnection = useCallback((chatId: string, connection: ConnectionState) => setConnections(current => ({ ...current, [chatId]: connection })), []);

  useEffect(() => {
    for (const [chatId, message] of Object.entries(pending)) {
      if (!message || !snapshots[chatId]?.submissions.some(submission => submission.requestId === message.requestId)) continue;
      setPending(current => current[chatId]?.requestId === message.requestId ? { ...current, [chatId]: undefined } : current);
      setDrafts(current => current[chatId]?.trim() === message.text ? { ...current, [chatId]: "" } : current);
      setSendErrors(current => ({ ...current, [chatId]: undefined }));
    }
  }, [pending, snapshots]);

  function activate(tab: WorkspaceTab) {
    setTabs(current => current.some(item => item.id === tab.id) ? current : [...current.filter(item => item.kind !== "welcome"), tab]);
    setActiveId(tab.id);
    setNavigationOpen(false);
    setSearchParams(tab.kind === "chat" ? { chat: tab.chatId } : {}, { replace: true });
  }

  function closeTab(tabId: string) {
    const remaining = tabs.filter(tab => tab.id !== tabId);
    const next = remaining.length ? remaining : [welcomeTab];
    setTabs(next);
    if (activeId === tabId) {
      const selected = next[Math.max(0, Math.min(tabs.findIndex(tab => tab.id === tabId) - 1, next.length - 1))];
      setActiveId(selected.id);
      setSearchParams(selected.kind === "chat" ? { chat: selected.chatId } : {}, { replace: true });
    }
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
    setPending(current => ({ ...current, [chatId]: { ...command, sending: true } }));
    setSendErrors(current => ({ ...current, [chatId]: undefined }));
    try {
      const snapshot = await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(chatId)}/messages`, command);
      setChats(current => mergeChat(current, snapshot.conversation));
      setPending(current => current[chatId]?.requestId === command.requestId ? { ...current, [chatId]: undefined } : current);
      setDrafts(current => current[chatId]?.trim() === command.text ? { ...current, [chatId]: "" } : current);
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
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
  const definition = snapshot ? agents.find(agent => agent.id === snapshot.conversation.agentDefinitionId) : undefined;
  const supporting = <ContextPanel kind={active.kind} snapshot={snapshot} definition={definition} tab={supportTabs[active.id] || "agent"} onTabChange={tab => setSupportTabs(current => ({ ...current, [active.id]: tab }))} />;
  const chatNav = () => {
    const existing = [...tabs].reverse().find(tab => tab.kind === "chat");
    activate(existing || welcomeTab);
  };
  const sidebar = <ConversationSidebar chats={chats} activeChatId={active.kind === "chat" ? active.chatId : undefined} companyName={config?.company.name || "Workspace"} creating={creating} onSelect={chatId => activate({ id: `chat:${chatId}`, kind: "chat", chatId })} onCreate={() => void createChat()} />;

  if (state?.state !== "authenticated") return null;
  if (loading) return <main className="page-loading"><Brand /><p><Spinner /> Opening your workspace…</p></main>;
  if (!config) return <main className="page-loading"><Brand /><Notice>{error || "The workspace could not be loaded."}</Notice><Button onClick={() => { setLoading(true); void load(); }}>Try again</Button><Button variant="ghost" onClick={() => void signOut()}>Sign out</Button></main>;

  return <div className="workspace">
    <a className="skip-link" href="#main-workspace">Skip to main content</a>
    <nav className="workspace-rail" aria-label="Workspace navigation"><div className="rail-brand"><Brand compact /></div><div className="rail-links">
      <IconButton label="Chats" className={active.kind === "chat" || active.kind === "welcome" ? "active" : ""} aria-pressed={active.kind === "chat" || active.kind === "welcome"} onClick={chatNav}><MessageSquare size={21} /></IconButton>
      <IconButton label="Agents" className={active.kind === "agents" ? "active" : ""} aria-pressed={active.kind === "agents"} onClick={() => activate({ id: "agents", kind: "agents" })}><Bot size={21} /></IconButton>
    </div><div className="rail-account"><IconButton label="Account and security" className={active.kind === "security" ? "active" : ""} aria-pressed={active.kind === "security"} onClick={() => activate({ id: "security", kind: "security" })}><Settings2 size={20} /></IconButton><IconButton label="Sign out" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? <Spinner /> : <LogOut size={19} />}</IconButton><span className="rail-avatar" title={state.user.name}>{state.user.name.slice(0, 1).toUpperCase()}</span></div></nav>
    <aside className="workspace-sidebar" aria-label="Conversations">{sidebar}</aside>
    <Tabs.Root className="workspace-content" value={activeId} onValueChange={value => { const tab = tabs.find(tab => tab.id === value); if (tab) activate(tab); }}>
      <div className="main-column">
        <header className="workspace-toolbar">
          <div className="mobile-navigation"><Modal title="Your workspace" description={config.company.name} side="left" open={navigationOpen} onOpenChange={setNavigationOpen} trigger={<IconButton label="Open navigation"><Menu size={21} /></IconButton>}>
            <nav className="mobile-destinations" aria-label="Workspace navigation"><Button variant="ghost" onClick={chatNav}><MessageSquare /> Chats</Button><Button variant="ghost" onClick={() => activate({ id: "agents", kind: "agents" })}><Bot /> Agents</Button><Button variant="ghost" onClick={() => activate({ id: "security", kind: "security" })}><Settings2 /> Account</Button></nav>{sidebar}<Button className="mobile-signout" variant="ghost" onClick={() => void signOut()} disabled={signingOut}><LogOut /> Sign out</Button>
          </Modal></div>
          <Tabs.List className="main-tabs" aria-label="Open work" activateOnFocus>{tabs.map(tab => <div className={`main-tab ${tab.id === activeId ? "selected" : ""}`} key={tab.id}>
            <Tabs.Tab value={tab.id}>{tab.kind === "chat" ? <MessageSquare size={14} /> : tab.kind === "agents" ? <Bot size={15} /> : tab.kind === "security" ? <Settings2 size={15} /> : <MessageSquare size={14} />}<span>{tab.kind === "chat" ? chats.find(chat => chat.id === tab.chatId)?.title || "Conversation" : tab.kind === "agents" ? "Agents" : tab.kind === "security" ? "Account" : "Workspace"}</span></Tabs.Tab>
            {tab.kind !== "welcome" ? <IconButton className="close-tab" label={`Close ${tab.kind === "chat" ? chats.find(chat => chat.id === tab.chatId)?.title || "conversation" : tab.kind} tab`} onClick={() => closeTab(tab.id)}><X size={13} /></IconButton> : null}
          </div>)}</Tabs.List>
          <IconButton label="New chat" disabled={creating} onClick={() => void createChat()}>{creating ? <Spinner /> : <Plus size={18} />}</IconButton>
          {active.kind !== "welcome" ? <div className="mobile-context"><Modal title={active.kind === "chat" ? "Conversation details" : active.kind === "agents" ? "About agent definitions" : "Account guidance"} description={active.kind === "chat" ? snapshot?.conversation.title || "Active conversation" : "For your current tab"} side="right" open={contextOpen} onOpenChange={setContextOpen} trigger={<IconButton label="Open supporting view"><PanelRight size={19} /></IconButton>}>{supporting}</Modal></div> : null}
        </header>
        {error ? <div className="workspace-notice"><Notice>{error}</Notice>{createFailed ? <Button variant="secondary" disabled={creating} onClick={() => void createChat(createRequest.current?.agentDefinitionId)}>Retry creating chat</Button> : <Button variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}</div> : null}
        <main className="workspace-main" id="main-workspace" tabIndex={-1}>
          {tabs.map(tab => <Tabs.Panel key={tab.id} value={tab.id} className="main-tab-panel" keepMounted={tab.kind === "agents"}>
            {tab.kind === "chat" ? <ChatPanel chatId={tab.chatId} snapshot={snapshots[tab.chatId]} draft={drafts[tab.chatId] || ""} pending={pending[tab.chatId]} sendError={sendErrors[tab.chatId]} providerReady={config.providerReady} onDraftChange={text => { setDrafts(current => ({ ...current, [tab.chatId]: text })); setSendErrors(current => ({ ...current, [tab.chatId]: undefined })); setPending(current => current[tab.chatId] && !current[tab.chatId]?.sending && current[tab.chatId]?.text !== text.trim() ? { ...current, [tab.chatId]: undefined } : current); }} onSend={() => void sendMessage(tab.chatId)} onSnapshot={onSnapshot} onConnection={onConnection} /> : tab.kind === "agents" ? <AgentsPage agents={agents} config={config} onSaved={updateAgent} onRefresh={load} onStartChat={agentId => void createChat(agentId)} creating={creating} /> : tab.kind === "security" ? <SecurityPage /> : <Welcome name={state.user.name} config={config} agents={agents} onCreate={agentId => void createChat(agentId)} creating={creating} />}
          </Tabs.Panel>)}
        </main>
      </div>
      <aside className="context-column" aria-label={active.kind === "chat" ? `Supporting views for ${snapshot?.conversation.title || "active conversation"}` : "Supporting view"}>{supporting}</aside>
    </Tabs.Root>
    <footer className="workspace-status"><span className={`connection-status connection-${connection || "connected"}`} role="status"><span aria-hidden="true" />{connection === "reconnecting" ? "Reconnecting · agent work continues" : connection === "connecting" ? "Connecting to conversation" : connection === "error" ? "Connection needs attention" : "Workspace connected"}</span><span className="status-company">{config.company.name}</span><span className="status-user">{state.user.name}</span></footer>
  </div>;
}

function ConversationSidebar({ chats, activeChatId, companyName, creating, onSelect, onCreate }: { chats: ChatSummary[]; activeChatId?: string; companyName: string; creating: boolean; onSelect: (id: string) => void; onCreate: () => void }) {
  const [search, setSearch] = useState("");
  const filtered = chats.filter(chat => chat.title.toLowerCase().includes(search.toLowerCase()));
  return <div className="conversation-sidebar"><header className="sidebar-brand"><Brand /><p>{companyName}</p></header><Button className="new-chat-button" onClick={onCreate} disabled={creating}>{creating ? <Spinner /> : <Plus />} New chat</Button><label className="conversation-search"><span className="sr-only">Find a conversation</span><Search size={15} aria-hidden="true" /><input type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Find a conversation" /></label><div className="sidebar-list-heading"><h2>Conversations</h2><span>{chats.length}</span></div><nav className="conversation-list" aria-label="Saved conversations">{filtered.map(chat => <button type="button" key={chat.id} onClick={() => onSelect(chat.id)} className={chat.id === activeChatId ? "selected" : ""} aria-current={chat.id === activeChatId ? "page" : undefined} title={chat.title}><MessageSquare size={15} aria-hidden="true" /><span>{chat.title}</span><span className={`conversation-dot dot-${chat.status}`} aria-label={statusLabels[chat.status]} /></button>)}{!filtered.length ? <p className="sidebar-empty">{search ? "No conversations match your search." : "Your conversations will appear here."}</p> : null}</nav><p className="sidebar-footer">A little more room to think.</p></div>;
}

function Welcome({ name, config, agents, creating, onCreate }: { name: string; config: ApplicationConfig; agents: AgentDefinition[]; creating: boolean; onCreate: (agentId: string) => void }) {
  const [agentId, setAgentId] = useState(config.defaultAgentId);
  return <section className="welcome-view"><div className="welcome-icon"><Brand compact /></div><span className="eyebrow">Hello, {name.split(" ")[0]}</span><h1>Where should we begin?</h1><p>A question, a plan, a problem to untangle.<br />Start a conversation and make some headway.</p><div className="welcome-actions"><label htmlFor="starting-agent">Start with</label><select id="starting-agent" value={agentId} onChange={event => setAgentId(event.target.value)}>{agents.filter(agent => !agent.archived).map(agent => <option value={agent.id} key={agent.id}>{agent.name}</option>)}</select><Button disabled={creating || !agentId} onClick={() => onCreate(agentId)}>{creating ? <Spinner /> : <Plus />} New chat</Button></div>{!config.providerReady ? <Notice tone="info">A model provider still needs to be connected before your agent can respond.</Notice> : null}<p className="welcome-footnote"><CircleHelp size={14} /> Each conversation starts fresh and keeps its own history.</p></section>;
}
