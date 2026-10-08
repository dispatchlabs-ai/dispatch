import { Archive, Package, Pencil, Plus } from "lucide-react";
import type { AgentDefinition } from "../shared/contracts";
import { SidebarSearch } from "./sidebar-search";
import { Button, IconButton } from "./ui";

export function AgentSidebar({
  agents,
  defaultAgentId,
  selectedAgentId,
  editing,
  busy,
  search,
  onSearchChange,
  showArchived,
  onShowArchivedChange,
  onCreate,
  onBundles,
  onSelect,
  onEdit,
  onArchive,
}: {
  agents: AgentDefinition[];
  defaultAgentId?: string;
  selectedAgentId?: string;
  editing: boolean | "new";
  busy: boolean;
  search: string;
  onSearchChange: (search: string) => void;
  showArchived: boolean;
  onShowArchivedChange: (show: boolean) => void;
  onCreate: () => void;
  onBundles: () => void;
  onSelect: (id: string) => void;
  onEdit: (agent: AgentDefinition) => void;
  onArchive: (agent: AgentDefinition) => void;
}) {
  const visible = agents.filter((agent) => agent.archived === showArchived);
  const filtered = visible.filter((agent) =>
    agent.name.toLowerCase().includes(search.toLowerCase()),
  );
  const archivedCount = agents.filter((agent) => agent.archived).length;
  return (
    <div className="collection-sidebar">
      <Button className="sidebar-create" disabled={busy} onClick={onCreate}>
        <Plus /> New agent
      </Button>
      <Button variant="secondary" disabled={busy} onClick={onBundles}><Package size={16} /> Import / export</Button>
      <SidebarSearch
        label="Find an agent"
        value={search}
        onChange={onSearchChange}
      />
      <div className="sidebar-list-heading">
        <h2>{showArchived ? "Archived agents" : "Agents"}</h2>
        <span>{visible.length}</span>
      </div>
      <nav
        className="sidebar-list"
        aria-label={showArchived ? "Archived agents" : "Saved agents"}
      >
        {editing === "new" ? (
          <div className="sidebar-row selected">
            <span className="sidebar-select" aria-current="page">
              <span>New agent</span>
              <span className="sidebar-tag">Unsaved</span>
            </span>
          </div>
        ) : null}
        {filtered.map((agent) => (
          <div
            key={agent.id}
            className={`sidebar-row ${agent.id === selectedAgentId && editing !== "new" ? "selected" : ""}`}
          >
            <button
              type="button"
              className="sidebar-select"
              disabled={busy}
              aria-current={
                agent.id === selectedAgentId && editing !== "new"
                  ? "page"
                  : undefined
              }
              title={agent.name}
              onClick={() => onSelect(agent.id)}
            >
              <span>{agent.name}</span>
              {editing === true && agent.id === selectedAgentId ? (
                <span className="sidebar-tag">Unsaved</span>
              ) : null}
              {agent.id === defaultAgentId ? (
                <span className="sidebar-tag">Default</span>
              ) : null}
            </button>
            {!agent.archived ? (
              <div className="sidebar-row-actions">
                <IconButton
                  label={`Edit agent: ${agent.name}`}
                  disabled={busy}
                  onClick={() => onEdit(agent)}
                >
                  <Pencil size={15} />
                </IconButton>
                {agent.id !== defaultAgentId ? <IconButton
                  label={`Archive agent: ${agent.name}`}
                  disabled={busy}
                  onClick={() => onArchive(agent)}
                >
                  <Archive size={15} />
                </IconButton> : null}
              </div>
            ) : null}
          </div>
        ))}
        {!filtered.length ? (
          <p className="sidebar-empty">
            {search
              ? "No agents match your search."
              : showArchived
                ? "No archived agents."
                : "Your agents will appear here."}
          </p>
        ) : null}
      </nav>
      <Button
        variant="ghost"
        className="sidebar-archive-toggle"
        onClick={() => onShowArchivedChange(!showArchived)}
      >
        <Archive size={16} />
        {showArchived ? "Back to agents" : `Archived agents (${archivedCount})`}
      </Button>
    </div>
  );
}
