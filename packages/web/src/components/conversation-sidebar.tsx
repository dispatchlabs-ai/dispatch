import { Archive, ChevronDown, ChevronRight, Folder, Pin, Plus } from "lucide-react";
import { useId } from "react";
import type { ChatSummary, Project, UpdateChatInput } from "../shared/contracts";
import { statusLabels } from "../lib/chat";
import { ConversationActions } from "./conversation-actions";
import { NewProjectButton, type NewProjectProps } from "./projects";
import { SidebarSearch } from "./sidebar-search";
import { Button, IconButton, Spinner } from "./ui";

type ConversationSidebarProps = {
  chats: ChatSummary[];
  projects: Project[];
  activeChatId?: string;
  activeProjectId?: string;
  search: string;
  onSearchChange: (value: string) => void;
  creating: boolean;
  updating: ReadonlySet<string>;
  showArchived: boolean;
  onShowArchivedChange: (value: boolean) => void;
  collapsedProjects: ReadonlySet<string>;
  onToggleProject: (id: string) => void;
  newProject: NewProjectProps;
  onSelect: (id: string) => void;
  onSelectProject: (id: string) => void;
  onCreate: () => void;
  onMove: (chat: ChatSummary) => void;
  onUpdate: (id: string, input: UpdateChatInput) => void;
};

export function ConversationSidebar({ chats, projects, activeChatId, activeProjectId, search, onSearchChange, creating, updating, showArchived, onShowArchivedChange, collapsedProjects, onToggleProject, newProject, onSelect, onSelectProject, onCreate, onMove, onUpdate }: ConversationSidebarProps) {
  const groupPrefix = useId();
  const visible = chats.filter(chat => chat.archived === showArchived);
  const query = search.trim().toLowerCase();
  const matches = (chat: ChatSummary) => chat.title.toLowerCase().includes(query);
  const groups = projects.map(project => {
    const members = visible.filter(chat => chat.projectId === project.id);
    const filtered = project.name.toLowerCase().includes(query) ? members : members.filter(matches);
    return { project, filtered };
  }).filter(({ project, filtered }) => !query || project.name.toLowerCase().includes(query) || filtered.length);
  const unassigned = visible.filter(chat => chat.projectId === null).filter(matches);
  const archived = visible.filter(chat => matches(chat) || projects.some(project => project.id === chat.projectId && project.name.toLowerCase().includes(query)));

  function row(chat: ChatSummary) {
    return <div key={chat.id} className={`sidebar-row ${chat.id === activeChatId ? "selected" : ""}`}>
      <button type="button" className="sidebar-select" onClick={() => onSelect(chat.id)} aria-current={chat.id === activeChatId ? "page" : undefined} title={chat.title}>
        <span>{chat.title}</span>
        {chat.pinned ? <Pin size={13} aria-label="Pinned" /> : null}
        <span className={`conversation-dot dot-${chat.status}`} aria-label={statusLabels[chat.status]} />
      </button>
      <div className="sidebar-row-actions"><ConversationActions chat={chat} busy={updating.has(chat.id)} onMove={onMove} onUpdate={onUpdate} /></div>
    </div>;
  }

  return <div className="collection-sidebar conversation-sidebar">
    <Button variant="secondary" className="sidebar-create" onClick={() => { onShowArchivedChange(false); onCreate(); }} disabled={creating}>{creating ? <Spinner /> : <Plus />} New conversation</Button>
    <SidebarSearch label="Search conversations" value={search} onChange={onSearchChange} />
    <div className="sidebar-list-heading"><h2>{showArchived ? "Archived" : "Conversations"}</h2></div>
    {!showArchived ? <NewProjectButton {...newProject} /> : null}
    <nav className="sidebar-list conversation-groups" aria-label={showArchived ? "Archived conversations" : "Saved conversations"}>
      {showArchived ? archived.map(row) : <>
        {groups.map(({ project, filtered }) => {
          const expanded = !!query || !collapsedProjects.has(project.id);
          const groupId = `${groupPrefix}-${project.id}`;
          return <div className="project-group" key={project.id}>
            <div className={`project-group-header ${project.id === activeProjectId ? "selected" : ""}`}>
              <IconButton className="project-expand" label={`${expanded ? "Collapse" : "Expand"} ${project.name}`} aria-expanded={expanded} aria-controls={groupId} disabled={!!query} onClick={() => onToggleProject(project.id)}>{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</IconButton>
              <button type="button" className="project-select" onClick={() => onSelectProject(project.id)} aria-current={project.id === activeProjectId ? "page" : undefined} title={project.name}>
                <Folder size={16} /><span>{project.name}</span>
              </button>
            </div>
            <div id={groupId} className="project-group-conversations" hidden={!expanded}>
              {filtered.map(row)}
            </div>
          </div>;
        })}
        {unassigned.length > 0 ? <div className={`unassigned-conversations ${projects.length ? "has-projects" : ""}`}>
          <h3>Without a project</h3>
          {unassigned.map(row)}
        </div> : null}
      </>}
      {(showArchived ? !archived.length : query && !groups.length && !unassigned.length) ? <p className="sidebar-empty">{query ? "No conversations or projects match your search." : "No archived conversations."}</p> : null}
    </nav>
    <Button variant="ghost" className="sidebar-archive-toggle" onClick={() => onShowArchivedChange(!showArchived)}><Archive size={16} /> {showArchived ? "Back to conversations" : "Archived conversations"}</Button>
  </div>;
}
