import { reconcileChat } from "../shared/chat-updates";
import type { CriteriaDraft } from "./definition-of-done";
import { ProjectArchiveImport } from "./project-archives";
import { ImportExportPage } from "./import-export";
import { SecretsPage } from "./secrets";
import { BundlesDialog } from "./bundles";
import { emptyAttachments } from "../lib/attachments";
import { Tabs } from "@base-ui/react/tabs";
import { Bot, ChevronLeft, ChevronRight, CircleHelp, Folder, LogOut, Menu, MessageSquare, PanelLeft, PanelRight, Plus, Settings2, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import { useSearchParams } from "react-router";
import type { AgentDefinition, ApplicationConfig, ChatSnapshot, ChatSummary, CreateChatInput, CreateProjectInput, Project, UpdateChatInput } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { ComposerContext, composerKey, useComposers } from "../lib/composers";
import { mergeChat, type ConnectionState } from "../lib/chat";
import { useSession } from "../lib/session";
import { AgentArchiveDialog, AgentDetails, AgentsPage, agentEditIsDirty, beginAgentEdit, type AgentEditing } from "./agents";
import { AgentSidebar } from "./agent-sidebar";
import { Brand } from "./brand";
import { ChatPanel } from "./chat";
import { NewConversationDialog } from "./conversation-people";
import { AddInstanceDialog, type OpenInstanceForm } from "./add-instance";
import { InviteParticipantsDialog, SharedContextPanel } from "./shared-conversation";
import { RenameConversationDialog } from "./rename-conversation-dialog";
import { ConversationSidebar } from "./conversation-sidebar";
import { ColumnResizeHandle } from "./column-resize-handle";
import { ContextPanel } from "./context-panel";
import { ProjectSettings, type ProjectEditing } from "./project-settings";
import { ProjectPage } from "./projects";
import { SecurityPage } from "./security";
import { McpConnectionsPage } from "./mcp-connections";
import { Button, IconButton, Modal, Notice, Spinner } from "./ui";

type WorkspaceTab = { id: string; kind: "chat"; chatId: string } | { id: string; kind: "project"; projectId: string } | { id: string; kind: "welcome" };
type WorkspaceSection = "chats" | "agents" | "security" | "connections" | "secrets" | "import-export";
const welcomeTab: WorkspaceTab = { id: "welcome", kind: "welcome" };
const appVersion = import.meta.env.VITE_APP_VERSION;

function tabLocation(tab: WorkspaceTab): Record<string, string> {
  return tab.kind === "chat" ? { chat: tab.chatId } : tab.kind === "project" ? { project: tab.projectId } : {};
}

function initialTab(params: URLSearchParams): WorkspaceTab {
  const chatId = params.get("chat");
  const projectId = params.get("project");
  return chatId ? { id: `chat:${chatId}`, kind: "chat", chatId } : projectId ? { id: `project:${projectId}`, kind: "project", projectId } : welcomeTab;
}

export function Workspace() {
  const { state, api, auth, setState } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const [criteriaDrafts, setCriteriaDrafts] = useState<Record<string, CriteriaDraft | undefined>>({});
  const [section, setSection] = useState<WorkspaceSection>(searchParams.get("section") === "import-export" ? "import-export" : searchParams.get("section") === "secrets" ? "secrets" : searchParams.get("section") === "connections" ? "connections" : "chats");
  const [visited, setVisited] = useState({ "import-export": searchParams.get("section") === "import-export", agents: false, security: false, secrets: searchParams.get("section") === "secrets", connections: searchParams.get("section") === "connections" });
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [evaluationAgent, setEvaluationAgent] = useState<string | null>(null);
  const [evaluationContext, setEvaluationContext] = useState<React.ReactNode>(null);
  const [evaluationGuard, setEvaluationGuard] = useState({ dirty: false, busy: false });
  const [editingAgent, setEditingAgent] = useState<AgentEditing | null>(null);
  const [pendingAgentAction, setPendingAgentAction] = useState<(() => void) | null>(null);
  const [archivingAgent, setArchivingAgent] = useState<AgentDefinition | null>(null);
  const [bundlesOpen, setBundlesOpen] = useState(false);
  const [agentSearch, setAgentSearch] = useState("");
  const [showArchivedAgents, setShowArchivedAgents] = useState(false);
  const [config, setConfig] = useState<ApplicationConfig | null>(null);
  const [chats, setChats] = useState<ChatSummary[]>([]);
  const [projectSearch, setProjectSearch] = useState<Record<string, string>>({});
  const [projectEditing, setProjectEditing] = useState<Record<string, ProjectEditing | null>>({});
  const createInFlight = useRef(false);
  const [focusChatId, setFocusChatId] = useState<string | null>(null);
  const [importingProject, setImportingProject] = useState(false);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectName, setProjectName] = useState("");
  const [creatingProject, setCreatingProject] = useState(false);
  const [projectError, setProjectError] = useState<string | null>(null);
  const projectRequest = useRef<CreateProjectInput | null>(null);
  const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(() => new Set());
  const [showArchivedChats, setShowArchivedChats] = useState(false);
  const [renamingChat, setRenamingChat] = useState<ChatSummary | null>(null);
  const [updatingChats, setUpdatingChats] = useState<Set<string>>(() => new Set());
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [tabs, setTabs] = useState<WorkspaceTab[]>(() => [initialTab(searchParams)]);
  const [activeId, setActiveId] = useState(() => initialTab(searchParams).id);
  const [snapshots, setSnapshots] = useState<Record<string, ChatSnapshot>>({});
  const [connections, setConnections] = useState<Record<string, ConnectionState>>({});
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [otherDetailsVisible, setOtherDetailsVisible] = useState(true);
  const [chatDetailsVisible, setChatDetailsVisible] = useState<Record<string, boolean>>({});
  const [preferredSidebarWidth, setSidebarWidth] = useState(280);
  const [preferredDetailsWidth, setDetailsWidth] = useState<number | null>(null);
  const [viewportWidth, setViewportWidth] = useState(() => typeof window === "undefined" ? 1440 : window.innerWidth);
  useEffect(() => {
    const updateWidth = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", updateWidth);
    return () => window.removeEventListener("resize", updateWidth);
  }, []);
  const sidebarMax = Math.max(200, Math.min(420, Math.floor(viewportWidth * .25)));
  const detailsMax = Math.max(240, Math.min(480, Math.floor(viewportWidth * .3)));
  const sidebarWidth = Math.min(preferredSidebarWidth, sidebarMax);
  const [creating, setCreating] = useState(false);
  const [signingOut, setSigningOut] = useState(false);
  const [search, setSearch] = useState("");
  const [newConversation, setNewConversation] = useState<{ agentIds: string[]; projectId: string | null } | null>(null);
  const [addingInstance, setAddingInstance] = useState<{ chatId: string; definitionId?: string; onCreated?: Parameters<OpenInstanceForm>[1] } | null>(null);
  const [invitingChatId, setInvitingChatId] = useState<string | null>(null);
  const [threads, setThreads] = useState<Record<string, string | null>>({});
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

  const [loadError, setLoadError] = useState<string | null>(null);
  const knownChats = useRef(new Set<string>());
  const lostAccess = useRef(new Set<string>());
  const refreshRequest = useRef<{ controller: AbortController; observed: Map<string, ChatSummary> } | null>(null);
  const load = useCallback(async () => {
    refreshRequest.current?.controller.abort();
    const request = { controller: new AbortController(), observed: new Map<string, ChatSummary>() };
    refreshRequest.current = request;
    const knownAtStart = new Set(knownChats.current);
    const { signal } = request.controller;
    try {
      const [nextConfig, chatResult, agentResult, projectResult] = await Promise.all([
        api<ApplicationConfig>("/api/config", undefined, signal), api<{ chats: ChatSummary[] }>("/api/chats", undefined, signal),
        api<{ agents: AgentDefinition[] }>("/api/agents", undefined, signal), api<{ projects: Project[] }>("/api/projects", undefined, signal),
      ]);
      if (signal.aborted) return;
      // New chats observed while the list was in flight may be absent from that response.
      const listed = new Map(chatResult.chats.map(chat => [chat.id, chat]));
      // Omissions of already-known chats revoke access, even without an SSE error.
      for (const id of knownAtStart) if (!listed.has(id)) lostAccess.current.add(id);
      // Only a fresh authorized list can lift an access-loss fence.
      for (const id of listed.keys()) {
        lostAccess.current.delete(id);
        knownChats.current.add(id);
      }
      for (const chat of request.observed.values()) {
        if (lostAccess.current.has(chat.id)) continue;
        if (!listed.has(chat.id) || listed.get(chat.id)!.revision < chat.revision) listed.set(chat.id, chat);
      }
      setConfig(nextConfig);
      setChats(current => {
        const existing = new Map(current.map(chat => [chat.id, chat]));
        return [...listed.values()].map(chat => {
          const previous = existing.get(chat.id);
          return previous && previous.revision > chat.revision ? previous : chat;
        }).sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt);
      });
      setSnapshots(current => Object.fromEntries(Object.entries(current).filter(([id]) => listed.has(id))));
      setAgents(agentResult.agents);
      setProjects(projectResult.projects);
      setLoadError(null);
    } catch (error) {
      if (!signal.aborted) setLoadError(errorMessage(error));
    } finally {
      if (refreshRequest.current === request) {
        refreshRequest.current = null;
        if (!signal.aborted) setLoading(false);
      }
    }
  }, [api]);

  useEffect(() => {
    void load();
    const refresh = () => {
      if (document.visibilityState === "visible" && !refreshRequest.current) void load();
    };
    document.addEventListener("visibilitychange", refresh);
    const timer = window.setInterval(refresh, 15_000);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(timer);
      refreshRequest.current?.controller.abort();
    };
  }, [load]);
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
  const onAccessLost = useCallback((id: string) => {
    lostAccess.current.add(id);
    setSnapshots(current => { const next = { ...current }; delete next[id]; return next; });
    setChats(current => current.filter(chat => chat.id !== id));
    void load();
  }, [load]);

  const onSnapshot = useCallback((snapshot: ChatSnapshot) => {
    if (lostAccess.current.has(snapshot.conversation.id)) return;
    knownChats.current.add(snapshot.conversation.id);
    const observed = refreshRequest.current?.observed;
    const previous = observed?.get(snapshot.conversation.id);
    if (!previous || previous.revision <= snapshot.conversation.revision) observed?.set(snapshot.conversation.id, snapshot.conversation);
    setSnapshots(current => current[snapshot.conversation.id]?.conversation.revision > snapshot.conversation.revision
      ? current : { ...current, [snapshot.conversation.id]: reconcileChat(current[snapshot.conversation.id], snapshot) });
    setChats(current => mergeChat(current, snapshot.conversation));
  }, []);
  const onConnection = useCallback((chatId: string, connection: ConnectionState) => setConnections(current => ({ ...current, [chatId]: connection })), []);

  const composers = useComposers(onSnapshot);
  const attachmentDrafts = composers.attachments;

  function selectSection(next: WorkspaceSection) {
    setSection(next);
    if (next === "connections" || next === "secrets" || next === "import-export") { setOtherDetailsVisible(false); setSearchParams({ section: next }, { replace: true }); }
    else if (searchParams.has("section")) setSearchParams({}, { replace: true });
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
    setSearchParams(tabLocation(tab), { replace: true });
  }

  function requestCloseTab(tabId: string) {
    const tab = tabs.find(item => item.id === tabId);
    const dirty = tab?.kind === "chat" && composers.isDirty(tab.chatId);
    if (tab?.kind === "project" && projectEditing[tab.projectId]?.busy) return;
    if (tab?.kind === "chat" && criteriaDrafts[tab.chatId]?.busy) return;
    if (dirty || (tab?.kind === "chat" && criteriaDrafts[tab.chatId]) || (tab?.kind === "project" && (projectEditing[tab.projectId] || projectSearch[tab.projectId]))) setClosingTab(tabId);
    else closeTab(tabId);
  }

  function closeTab(tabId: string) {
    const closing = tabs.find(tab => tab.id === tabId);
    if (closing?.kind === "project") {
      setProjectEditing(current => ({ ...current, [closing.projectId]: null }));
      setProjectSearch(current => { const next = { ...current }; delete next[closing.projectId]; return next; });
    }
    if (closing?.kind === "chat") {
      setCriteriaDrafts(current => ({ ...current, [closing.chatId]: undefined }));
      composers.close(closing.chatId);
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
      setSearchParams(tabLocation(selected), { replace: true });
    }
    requestAnimationFrame(() => {
      (tabList.current?.querySelector<HTMLElement>(`[data-work-tab="${CSS.escape(focusId)}"]`) ?? document.getElementById("main-workspace"))?.focus();
    });
  }

  function chooseAgents(agentId = config?.defaultAgentId, projectId: string | null = null) {
    setNavigationOpen(false);
    setError(null);
    const project = projects.find(item => item.id === projectId);
    if (project?.canParticipate === false) return;
    setNewConversation({ agentIds: project ? project.defaultAgentDefinitionIds ?? [] : agentId ? [agentId] : [], projectId });
  }

  async function createChat(agentIds: string[] | undefined, projectId: string | null = null, retry?: CreateChatInput, title?: string) {
    if (creating || createInFlight.current || (createFailed && !retry)) return;
    createInFlight.current = true;
    const sharedProjectId = projectId;
    const sameRequest = createRequest.current?.title === title && JSON.stringify(createRequest.current?.agentDefinitionIds) === JSON.stringify(agentIds) && (createRequest.current?.sharedProjectId ?? null) === sharedProjectId;
    if (retry) createRequest.current = retry;
    else if (!sameRequest) createRequest.current = { requestId: crypto.randomUUID(), agentDefinitionIds: agentIds, sharedProjectId, title };
    setCreating(true); setError(null); setCreateFailed(false);
    try {
      const snapshot = await api<ChatSnapshot>("/api/chats", createRequest.current);
      onSnapshot(snapshot);
      createRequest.current = null;
      setNewConversation(null);
      setFocusChatId(snapshot.conversation.id);
      setShowArchivedChats(false);
      setSearch("");
      const projectId = snapshot.conversation.projectId;
      if (projectId) setCollapsedProjects(current => { const next = new Set(current); next.delete(projectId); return next; });
      activate({ id: `chat:${snapshot.conversation.id}`, kind: "chat", chatId: snapshot.conversation.id });
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) createRequest.current = null;
      else setCreateFailed(true);
    } finally { createInFlight.current = false; setCreating(false); }
  }

  function selectProject(projectId: string) {
    setShowArchivedChats(false);
    setCollapsedProjects(current => { const next = new Set(current); next.delete(projectId); return next; });
    activate({ id: `project:${projectId}`, kind: "project", projectId });
  }

  async function createProject(): Promise<boolean> {
    const name = projectName.trim();
    if (creatingProject || !name) return false;
    if (projectRequest.current?.name !== name) projectRequest.current = { requestId: crypto.randomUUID(), name, kind: "shared" };
    setCreatingProject(true); setProjectError(null);
    try {
      const { project } = await api<{ project: Project }>("/api/projects", projectRequest.current);
      setProjects(current => mergeProjects(current, [project]));
      projectRequest.current = null;
      setProjectName(""); setSearch("");
      selectProject(project.id);
      requestAnimationFrame(() => document.getElementById("main-workspace")?.focus());
      return true;
    } catch (error) {
      setProjectError(errorMessage(error));
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) projectRequest.current = null;
      return false;
    } finally { setCreatingProject(false); }
  }

  async function updateChat(id: string, input: UpdateChatInput) {
    setUpdatingChats(current => new Set(current).add(id));
    try {
      onSnapshot(await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(id)}/preferences`, input));
      if (input.archived !== undefined) requestAnimationFrame(() => {
        const sidebar = navigationOpen ? document.querySelector(".dialog-drawer") : document.getElementById("workspace-sidebar");
        sidebar?.querySelector<HTMLButtonElement>(".sidebar-archive-toggle")?.focus();
      });
    } finally {
      setUpdatingChats(current => { const next = new Set(current); next.delete(id); return next; });
    }
  }

  function updateChatAction(id: string, input: UpdateChatInput) {
    setError(null);
    void updateChat(id, input).catch(error => setError(errorMessage(error)));
  }

  function renameChat(chat: ChatSummary) {
    setNavigationOpen(false);
    setRenamingChat(chat);
  }

  async function saveChatTitle(id: string, title: string) {
    onSnapshot(await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(id)}/title`, { title }));
  }

  const openSupporting = useCallback((chatId: string, threadId: string | null) => {
    setThreads(current => ({ ...current, [chatId]: threadId }));
    setChatDetailsVisible(current => ({ ...current, [chatId]: true }));
    if (viewportWidth <= 800) setContextOpen(true);
    else requestAnimationFrame(() => document.querySelector<HTMLElement>("#details-column .shared-context")?.focus());
  }, [viewportWidth]);

  async function signOut() {
    setSigningOut(true); setError(null);
    try { setState(await auth("/api/auth/logout", {})); } catch (error) { setError(errorMessage(error)); } finally { setSigningOut(false); }
  }

  function updateAgent(agent: AgentDefinition) { setAgents(current => [agent, ...current.filter(item => item.id !== agent.id)].sort((a, b) => a.name.localeCompare(b.name))); }

  function requestAgentAction(action: () => void) {
    if (editingAgent?.busy || evaluationGuard.busy) return;
    if (evaluationGuard.dirty && !window.confirm("Discard evaluation changes?")) return;
    setNavigationOpen(false);
    if (editingAgent && agentEditIsDirty(editingAgent)) setPendingAgentAction(() => action);
    else action();
  }

  function editAgent(agent?: AgentDefinition) {
    requestAgentAction(() => {
      setOtherDetailsVisible(true);
      setEditingAgent(beginAgentEdit(agent, agents.find(item => item.id === config?.defaultAgentId)));
      if (agent) setSelectedAgentId(agent.id);
      else { setAgentSearch(""); setShowArchivedAgents(false); }
    });
  }

  function finishAgentEdit(agent?: AgentDefinition) {
    if (agent) { updateAgent(agent); setSelectedAgentId(agent.id); }
    if (!agent || agent.id === config?.defaultAgentId) void load();
    setEditingAgent(null);
    requestAnimationFrame(() => document.getElementById("main-workspace")?.focus());
  }

  const settingsSection = section === "security" || section === "connections" || section === "secrets" || section === "import-export";
  const selectedAgent = agents.find(agent => agent.id === selectedAgentId) ?? agents.find(agent => agent.id === config?.defaultAgentId);
  const active: WorkspaceTab | { id: string; kind: "agents" | "security" | "connections" | "secrets" | "import-export" } = section === "chats" ? tabs.find(tab => tab.id === activeId) || welcomeTab : { id: section, kind: section };
  const detailsVisible = active.kind === "chat" ? chatDetailsVisible[active.chatId] ?? false : active.kind === "connections" || active.kind === "secrets" || active.kind === "import-export" ? false : otherDetailsVisible;
  const detailsWidth = Math.min(preferredDetailsWidth ?? (active.kind === "chat" ? 440 : 360), detailsMax);
  function setDetailsVisible(visible: boolean) {
    if (active.kind === "chat") setChatDetailsVisible(current => ({ ...current, [active.chatId]: visible }));
    else setOtherDetailsVisible(visible);
  }
  const snapshot = active.kind === "chat" ? snapshots[active.chatId] : undefined;
  const connection = active.kind === "chat" ? connections[active.chatId] || "connecting" : null;
  const activeProjectId = active.kind === "project" ? active.projectId : active.kind === "chat" ? chats.find(chat => chat.id === active.chatId)?.projectId ?? null : null;
  const selectedProject = active.kind === "project" ? projects.find(project => project.id === active.projectId) : undefined;
  const supportingKey = active.kind === "chat" ? composerKey(active.chatId, threads[active.chatId]) : "";
  const supporting = (inDrawer = false) => selectedProject ? <ProjectSettings key={selectedProject.id}
    project={selectedProject} agents={agents} showHeader={!inDrawer}
    editing={projectEditing[selectedProject.id] ?? null}
    onEditingChange={editing => setProjectEditing(current => ({ ...current, [selectedProject.id]: editing }))}
    onSaved={project => { setProjects(current => mergeProjects(current, [project])); void load(); }} /> : section === "agents" && !editingAgent && evaluationAgent === selectedAgent?.id ? <div className="agent-details">{!inDrawer ? <header className="context-header"><h2>Evaluation profile</h2></header> : null}<div className="context-body">{evaluationContext}</div></div> : section === "agents" ? <AgentDetails agent={selectedAgent} editing={editingAgent} config={config} showHeader={!inDrawer} /> : active.kind === "chat" && snapshot ? <SharedContextPanel agents={agents} key={snapshot.conversation.id} snapshot={snapshot} models={config?.models ?? []} threadId={threads[active.chatId] ?? null}
    criteriaDraft={criteriaDrafts[active.chatId]} onCriteriaDraft={draft => setCriteriaDrafts(current => ({ ...current, [active.chatId]: draft }))}
    attachments={attachmentDrafts.drafts[supportingKey] ?? emptyAttachments}
    onAddFiles={files => attachmentDrafts.add(supportingKey, active.chatId, files)}
    onRemoveAttachment={id => attachmentDrafts.remove(supportingKey, id)}
    onRetryAttachment={id => attachmentDrafts.retry(supportingKey, active.chatId, id)}
    onSnapshot={onSnapshot} onInvite={() => setInvitingChatId(active.chatId)} onAddInstance={(definitionId, onCreated) => setAddingInstance({ chatId: active.chatId, definitionId, onCreated })}
    onClose={() => {
      setThreads(current => ({ ...current, [active.chatId]: null }));
      setDetailsVisible(false);
      setContextOpen(false);
      requestAnimationFrame(() => document.getElementById(`participants-${active.chatId}`)?.focus());
    }} showHeader={!inDrawer}
    /> : <ContextPanel kind={active.kind === "connections" || active.kind === "secrets" || active.kind === "import-export" ? "security" : active.kind} />;
  const chatNav = () => selectSection("chats");
  const selectChat = (chatId: string) => activate({ id: `chat:${chatId}`, kind: "chat", chatId });
  const conversations = <ConversationSidebar chats={chats} projects={projects}
    activeChatId={active.kind === "chat" ? active.chatId : undefined} activeProjectId={active.kind === "project" ? active.projectId : undefined}
    search={search} onSearchChange={setSearch} creating={creating || createFailed} updating={updatingChats}
    showArchived={showArchivedChats} onShowArchivedChange={setShowArchivedChats} collapsedProjects={collapsedProjects}
    onToggleProject={id => setCollapsedProjects(current => { const next = new Set(current); if (!next.delete(id)) next.add(id); return next; })}
    newProject={{ name: projectName, busy: creatingProject, error: projectError, compact: viewportWidth <= 1100,
      onNameChange: name => { setProjectName(name); setProjectError(null); }, onCreate: createProject,
      onCancel: () => { setProjectName(""); setProjectError(null); projectRequest.current = null; } }}
    onCreateProjectChat={project => { if (project.canParticipate === false) return; void createChat(undefined, project.id); }}
    onSelect={selectChat} onSelectProject={selectProject} onCreate={() => chooseAgents(config?.defaultAgentId, activeProjectId)}
    onRename={renameChat} onUpdate={updateChatAction} />;
  const sidebar = <>
    <div className="section-sidebar-panel" hidden={section !== "chats"}>{conversations}</div>
    <div className="section-sidebar-panel" hidden={section !== "agents"}>
      <AgentSidebar agents={agents} defaultAgentId={config?.defaultAgentId}
        selectedAgentId={editingAgent?.saved?.id ?? selectedAgent?.id}
        editing={editingAgent ? editingAgent.saved ? agentEditIsDirty(editingAgent) : "new" : false} busy={editingAgent?.busy ?? false}
        search={agentSearch} onSearchChange={setAgentSearch} showArchived={showArchivedAgents} onShowArchivedChange={setShowArchivedAgents}
        onBundles={() => { setNavigationOpen(false); setBundlesOpen(true); }} onCreate={() => editAgent()}
        onSelect={id => requestAgentAction(() => { setEditingAgent(null); setSelectedAgentId(id); })}
        onEdit={editAgent}
        onArchive={agent => requestAgentAction(() => { setEditingAgent(null); setArchivingAgent(agent); })} />
    </div>
    {settingsSection ? <div className="section-sidebar">
      <h2>Settings</h2>
      <nav aria-label="Settings">
        <Button variant="ghost" aria-current={section === "connections" ? "page" : undefined} onClick={() => selectSection("connections")}>Connections</Button>
        <Button variant="ghost" aria-current={section === "secrets" ? "page" : undefined} onClick={() => selectSection("secrets")}>Secrets</Button>
        <Button variant="ghost" aria-current={section === "import-export" ? "page" : undefined} onClick={() => selectSection("import-export")}>Import &amp; export</Button>
        <Button variant="ghost" aria-current={section === "security" ? "page" : undefined} onClick={() => selectSection("security")}>Account and security</Button>
        {section === "security" ? [['passkeys', 'Passkeys'], ['password', 'Password & authenticator'], ['sessions', 'Active sessions']].map(([id, label]) => <Button key={id} variant="ghost" onClick={() => {
          setNavigationOpen(false);
          requestAnimationFrame(() => document.getElementById(`account-${id}`)?.scrollIntoView({ block: "start" }));
        }}>{label}</Button>) : null}
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
    <Notice>{error || loadError || "The workspace could not be loaded."}</Notice>
    <Button onClick={() => { setLoading(true); void load(); }}>Try again</Button>
    <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button>
  </main>;

  return <ComposerContext.Provider value={composers}><div className={`workspace ${section === "agents" && editingAgent ? "agent-editing" : ""} ${sidebarVisible ? "" : "sidebar-hidden"} ${detailsVisible ? "" : "details-hidden"}`}
    style={{ "--sidebar-width": `${sidebarVisible ? sidebarWidth : 0}px`, "--details-width": `${detailsVisible ? detailsWidth : 0}px` } as CSSProperties}>
    <a className="skip-link" href="#main-workspace">Skip to main content</a>
    <nav className="workspace-rail" aria-label="Workspace navigation">
      <div className="rail-brand">
        <Brand compact />
      </div>
      <div className="rail-links">
        <IconButton label="Chats" className={section === "chats" ? "active" : ""} aria-current={section === "chats" ? "page" : undefined} onClick={chatNav}>
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
        {section !== "connections" && section !== "secrets" && section !== "import-export" ? <IconButton className="details-toggle" label={detailsVisible ? "Hide details" : "Show details"} aria-expanded={detailsVisible} aria-controls="details-column" onClick={() => setDetailsVisible(!detailsVisible)}>
          <PanelRight size={19} />
        </IconButton> : null}
      </div>
      <div className="rail-account">
        <IconButton label="Settings" className={settingsSection ? "active" : ""} aria-current={settingsSection ? "page" : undefined} onClick={() => selectSection("connections")}>
          <Settings2 size={20} />
        </IconButton>
        <IconButton label="Sign out" disabled={signingOut} onClick={() => void signOut()}>{signingOut ? <Spinner /> : <LogOut size={19} />}</IconButton>
        <span className="rail-avatar" title={state.user.name}>{state.user.name.slice(0, 1).toUpperCase()}
        </span>
      </div>
    </nav>
    <aside className="workspace-sidebar" id="workspace-sidebar" aria-label={section === "chats" ? "Chats" : section === "agents" ? "Agents" : "Account"}>
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
                  const title = tab.kind === "chat" ? chats.find(chat => chat.id === tab.chatId)?.title || "Chat" : tab.kind === "project" ? projects.find(project => project.id === tab.projectId)?.name || "Project" : "Workspace";
                  return <div key={tab.id} role="presentation" className={`main-tab-item ${tab.id === activeId ? "selected" : ""}`}>
                    <Tabs.Tab value={tab.id} data-work-tab={tab.id} className="main-tab"
                      onKeyDown={event => {
                        if (event.key === "Delete" && tab.kind !== "welcome") {
                          event.preventDefault();
                          requestCloseTab(tab.id);
                        }
                      }}>
                      {tab.kind === "project" ? <Folder size={14} /> : <MessageSquare size={14} />}
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
        {loadError ? <div className="workspace-notice">
          <Notice>Workspace refresh failed: {loadError}</Notice><Button variant="secondary" onClick={() => void load()}>Retry refresh</Button>
        </div> : null}
        {error || createFailed ? <div className="workspace-notice">
          <Notice>{error ?? "Chat creation could not be confirmed. Retry to recover it."}</Notice>{createFailed ? <Button variant="secondary" disabled={creating} onClick={() => void createChat([], null, createRequest.current ?? undefined)}>Retry creating chat</Button> : <Button variant="ghost" onClick={() => setError(null)}>Dismiss</Button>}
        </div> : null}
        <main className="workspace-main" id="main-workspace" tabIndex={-1}>
          <div className="workspace-section" hidden={section !== "chats"}>
          {tabs.map(tab => <Tabs.Panel key={tab.id} value={tab.id} className="main-tab-panel" role={tabs.length === 1 ? "region" : "tabpanel"} aria-label={tabs.length === 1 ? "Workspace content" : undefined} keepMounted>
            {tab.kind === "chat" ? <ChatPanel agents={agents}
              active={section === "chats" && tab.id === activeId}
              connection={connections[tab.chatId] || "connecting"}
              focusComposer={focusChatId === tab.chatId}
              onComposerFocused={() => setFocusChatId(null)}
              chatId={tab.chatId}
              snapshot={snapshots[tab.chatId]}
              attachments={attachmentDrafts.drafts[tab.chatId] ?? emptyAttachments}
              onAddFiles={files => attachmentDrafts.add(tab.chatId, tab.chatId, files)}
              onRemoveAttachment={id => attachmentDrafts.remove(tab.chatId, id)}
              onRetryAttachment={id => attachmentDrafts.retry(tab.chatId, tab.chatId, id)}
              activeThreadId={(viewportWidth <= 800 ? contextOpen : chatDetailsVisible[tab.chatId]) ? threads[tab.chatId] : null}
              onParticipants={() => openSupporting(tab.chatId, null)}
              onAddInstance={(definitionId, onCreated) => setAddingInstance({ chatId: tab.chatId, definitionId, onCreated })}
              onThread={openSupporting}
              onSnapshot={onSnapshot}
              onConnection={onConnection}
              onAccessLost={onAccessLost}
            /> : tab.kind === "project" ? <ProjectPage
              search={projectSearch[tab.projectId] ?? ""} onSearchChange={search => setProjectSearch(current => ({ ...current, [tab.projectId]: search }))}
              project={projects.find(project => project.id === tab.projectId)} chats={chats} creating={creating || createFailed} updating={updatingChats}
              onCreate={() => chooseAgents(config.defaultAgentId, tab.projectId)} onSelect={selectChat}
              onRename={renameChat} onUpdate={updateChatAction}
            /> : <Welcome
              name={state.user.name} config={config}
              onCreate={() => chooseAgents()} creating={creating || createFailed}
            />}
          </Tabs.Panel>)}
          </div>
          {visited.agents ? <div className="workspace-section" hidden={section !== "agents"}>
            <AgentsPage evaluationAgent={evaluationAgent} onEvaluationAgentChange={setEvaluationAgent} onEvaluationContextChange={setEvaluationContext} onEvaluationGuardChange={setEvaluationGuard} agent={selectedAgent} editing={editingAgent} config={config} onEditingChange={setEditingAgent}
              onSaved={finishAgentEdit} onConnectionsSettings={() => selectSection("connections")}
              onCancel={() => requestAgentAction(() => finishAgentEdit())} onEdit={editAgent}
              onStartChat={agentId => chooseAgents(agentId)} creating={creating || createFailed} />
          </div> : null}
          {visited["import-export"] ? <div className="workspace-section" hidden={section !== "import-export"}><ImportExportPage projects={projects} chats={chats} onImport={() => setImportingProject(true)} /></div> : null}
          {visited.secrets ? <div className="workspace-section" hidden={section !== "secrets"}><SecretsPage /></div> : null}
          {visited.connections ? <div className="workspace-section" hidden={section !== "connections"}><McpConnectionsPage /></div> : null}
          {visited.security ? <div className="workspace-section" hidden={section !== "security"}><SecurityPage /></div> : null}
        </main>
      </div>
      <aside className="context-column" id="details-column" aria-label={active.kind === "chat" ? `Supporting views for ${snapshot?.conversation.title || "active conversation"}` : section === "agents" ? "Agent supporting view" : "Supporting view"}>
        <ColumnResizeHandle side="right" controls="details-column" width={detailsWidth} min={240} max={detailsMax} onResize={setDetailsWidth} />
        <div className="context-column-content">{supporting()}</div>
      </aside>
    </Tabs.Root>
    <ProjectArchiveImport open={importingProject} onOpenChange={setImportingProject} onImported={project => { setProjects(current => mergeProjects(current, [project])); selectProject(project.id); }} />
    {addingInstance ? <AddInstanceDialog key={addingInstance.chatId} chatId={addingInstance.chatId} initialDefinitionId={addingInstance.definitionId} onCreated={addingInstance.onCreated} removingDefinitionIds={(snapshots[addingInstance.chatId]?.participants ?? []).flatMap(person => person.kind === "agent" && person.membership === "removing" ? [person.agentDefinitionId] : [])} agents={agents} canParticipate={Boolean(snapshots[addingInstance.chatId]) && snapshots[addingInstance.chatId]?.conversation.canParticipate !== false} onSnapshot={onSnapshot} onClose={() => setAddingInstance(null)} /> : null}
    {invitingChatId && snapshots[invitingChatId] ? <InviteParticipantsDialog key={invitingChatId} snapshot={snapshots[invitingChatId]} agents={agents} onSnapshot={onSnapshot} onClose={() => setInvitingChatId(null)} /> : null}
    {newConversation ? <NewConversationDialog agents={agents} initialAgentIds={newConversation.agentIds} projectName={projects.find(project => project.id === newConversation.projectId)?.name} busy={creating} error={error} onClose={() => setNewConversation(null)} onCreate={(ids, title) => void createChat(ids, newConversation.projectId, undefined, title)} /> : null}
    {renamingChat ? <RenameConversationDialog key={renamingChat.id} chat={renamingChat} onClose={() => setRenamingChat(null)} onRename={saveChatTitle} /> : null}
    <BundlesDialog open={bundlesOpen} onClose={() => setBundlesOpen(false)} agents={agents} models={config?.models ?? []} onImported={load} />
    <Modal title="Discard agent changes?" description="Your unsaved changes will be lost."
      open={pendingAgentAction !== null} onOpenChange={open => { if (!open) setPendingAgentAction(null); }}
      finalFocus={() => document.getElementById("main-workspace")}>
      <div className="button-row">
        <Button variant="secondary" onClick={() => setPendingAgentAction(null)}>Keep editing</Button>
        <Button variant="danger" onClick={() => { pendingAgentAction?.(); setPendingAgentAction(null); }}>Discard changes</Button>
      </div>
    </Modal>
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
              <Button variant="ghost" aria-current={section === "chats" ? "page" : undefined} onClick={chatNav}>
                <MessageSquare /> Chats</Button>
              <Button variant="ghost" aria-current={active.kind === "agents" ? "page" : undefined} onClick={() => selectSection("agents")}>
                <Bot /> Agents</Button>
              <Button variant="ghost" aria-current={settingsSection ? "page" : undefined} onClick={() => selectSection("connections")}>
                <Settings2 /> Settings</Button>
            </nav>{sidebar}
            <div className="mobile-menu-footer">
              <Button variant="ghost" onClick={() => void signOut()} disabled={signingOut}>
                <LogOut /> Sign out</Button>
              <span className="app-version"><span className="sr-only">Dispatch version </span>v{appVersion}</span>
            </div>
          </Modal>
        </div>
        {active.kind !== "welcome" && active.kind !== "connections" && active.kind !== "import-export" ? <div className="mobile-context">
          <Modal title={active.kind === "chat" ? threads[active.chatId] ? "Thread" : "Participants" : section === "agents" ? editingAgent ? "Draft preview" : "Agent details" : "Details"} description={active.kind === "chat" ? snapshot?.conversation.title || "Active conversation" : section === "agents" ? undefined : "For your current view"} side="right" open={contextOpen} onOpenChange={setContextOpen} trigger={<Button variant="ghost" className="workspace-action">
            <PanelRight size={19} /> Details</Button>}>{supporting(true)}</Modal>
        </div> : null}
      </div>
      <span className={`connection-status connection-${connection || "unobserved"}`} role="status">
        <span aria-hidden="true" />{connection === "reconnecting" ? "Reconnecting · agent work continues" : connection === "connecting" ? "Connecting to conversation" : connection === "error" ? "Connection needs attention" : connection === "connected" ? "Conversation connected" : "No live conversation selected"}</span>
      <span className="status-company">{config.company.name}</span>
      <span className="status-user">{state.user.name}</span>
      <span className="app-version status-version"><span className="sr-only">Dispatch version </span>v{appVersion}</span>
    </footer>
  </div></ComposerContext.Provider>;
}

function mergeProjects(current: Project[], incoming: Project[]) {
  const byId = new Map(current.map(project => [project.id, project]));
  for (const project of incoming) byId.set(project.id, project);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function Welcome({ name, config, creating, onCreate }: {
  name: string; config: ApplicationConfig; creating: boolean; onCreate: () => void;
}) {
  return <section className="welcome-view">
    <span className="eyebrow">Hello, {name.split(" ")[0]}</span>
    <h1>Your workspace</h1>
    <p>A question, a plan, a problem to untangle.<br />Start a chat and make some headway.</p>
    <div className="welcome-actions">
      <Button disabled={creating} onClick={onCreate}>{creating ? <Spinner /> : <Plus />} New chat</Button>
    </div>{!config.providerReady ? <Notice tone="info">The default agent is not connected yet. Choose another configured agent or ask your operator to connect it.</Notice> : null}
    <p className="welcome-footnote">
      <CircleHelp size={14} /> Each chat starts fresh and keeps its own history.</p>
  </section>;
}
