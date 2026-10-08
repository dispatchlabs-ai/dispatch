import { Popover } from "@base-ui/react/popover";
import { FolderPlus, MessageSquare, Pin, Plus, Search } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ChatSummary, Project, UpdateChatInput } from "../shared/contracts";
import { statusLabels } from "../lib/chat";
import { ConversationActions } from "./conversation-actions";
import { Button, Field, Input, Notice, Spinner } from "./ui";

export type NewProjectProps = {
  name: string;
  busy: boolean;
  error: string | null;
  compact: boolean;
  onNameChange: (name: string) => void;
  onCreate: () => Promise<boolean>;
  onCancel: () => void;
};

export function NewProjectButton({ name, busy, error, compact, onNameChange, onCreate, onCancel }: NewProjectProps) {
  const [open, setOpen] = useState(false);
  const created = useRef(false);
  useEffect(() => { setOpen(false); }, [compact]);
  return <Popover.Root open={open} onOpenChange={next => { if (!busy) { if (next) created.current = false; setOpen(next); } }}>
    <Popover.Trigger render={<Button variant="ghost" className="new-project-button"><FolderPlus /> New project</Button>} />
    <Popover.Portal>
      <Popover.Positioner className="project-popover-positioner" side={compact ? "bottom" : "right"} align="start" sideOffset={10} collisionPadding={16}>
        <Popover.Popup className="project-popover" finalFocus={() => created.current ? document.getElementById("main-workspace") : true}>
          <Popover.Title>New shared project</Popover.Title>
          <p>Starts with only you as manager. Add members in project settings; members can read its full history.</p>
          <form onSubmit={async event => { event.preventDefault(); if (await onCreate()) { created.current = true; setOpen(false); } }}>
            <Field label="Name">{props => <Input {...props} value={name} onChange={event => onNameChange(event.target.value)} placeholder="Project name" required maxLength={100} disabled={busy} />}</Field>
            {error ? <Notice>{error}</Notice> : null}
            <div className="button-row project-form-actions">
              <Button variant="secondary" disabled={busy} onClick={() => { onCancel(); setOpen(false); }}>Cancel</Button>
              <Button type="submit" disabled={busy || !name.trim()}>{busy ? <Spinner label="Creating project" /> : null} Create project</Button>
            </div>
          </form>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

export function ProjectPage({ project, chats, creating, updating, onCreate, onSelect, onRename, onUpdate, search, onSearchChange }: {
  search: string;
  onSearchChange: (search: string) => void;
  project?: Project;
  chats: ChatSummary[];
  creating: boolean;
  updating: ReadonlySet<string>;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRename: (chat: ChatSummary) => void;
  onUpdate: (id: string, input: UpdateChatInput) => void;
}) {
  const [activeOnly, setActiveOnly] = useState(false);
  if (!project) return <div className="project-page"><h1>Project unavailable</h1><p className="text-muted">Choose a project from Chats.</p></div>;
  const projectChats = chats.filter(chat => chat.projectId === project.id && !chat.archived);
  const visible = projectChats.filter(chat => (!activeOnly || chat.status === "running") && chat.title.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  return <section className="project-page">
    <header className="project-page-header">
      <div><p className="eyebrow">Shared project</p><h1>{project.name}</h1></div>
      <Button disabled={creating || project.canParticipate === false} onClick={onCreate}>{creating ? <Spinner /> : <Plus />} New chat</Button>
    </header>
    <div className="project-toolbar">
      <div className="search-input"><Search size={18} aria-hidden="true" /><Input type="search" aria-label="Search chats in this project" placeholder="Search chats in this project…" value={search} onChange={event => onSearchChange(event.target.value)} /></div>
      <div className="segmented-control" role="group" aria-label="Filter project chats">
        <Button variant="ghost" aria-pressed={!activeOnly} onClick={() => setActiveOnly(false)}>All chats</Button>
        <Button variant="ghost" aria-pressed={activeOnly} onClick={() => setActiveOnly(true)}>Active</Button>
      </div>
    </div>
    <div className="project-list-heading" aria-hidden="true"><span>Chat</span><span>Status</span><span>Last activity</span><span /></div>
    <p className="sr-only" role="status">{visible.length} {visible.length === 1 ? "chat" : "chats"}</p>
    {visible.length ? <ul className="project-conversations">
      {visible.map(chat => <li key={chat.id}>
        <button className="project-conversation-link" onClick={() => onSelect(chat.id)} type="button">
          <span className="project-chat-title"><span className="project-chat-icon"><MessageSquare size={21} aria-hidden="true" /></span><span>{chat.title}</span>{chat.pinned ? <Pin size={14} aria-label="Pinned" /> : null}</span>
          <span className={`status-badge project-chat-status status-${chat.status}`}>{statusLabels[chat.status]}</span>
          <time dateTime={new Date(chat.updatedAt).toISOString()}>{conversationDate(chat.updatedAt)}</time>
        </button>
        <ConversationActions chat={chat} busy={updating.has(chat.id)} onRename={onRename} onUpdate={onUpdate} />
      </li>)}
    </ul> : <div className="project-empty"><p>{projectChats.length ? "No matching chats." : "No chats yet."}</p>{projectChats.length ? <Button variant="ghost" onClick={() => { onSearchChange(""); setActiveOnly(false); }}>Clear filters</Button> : <p>Start a chat in this project.</p>}</div>}
  </section>;
}

function conversationDate(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) }).format(date);
}
