import { Popover } from "@base-ui/react/popover";
import { FolderPlus, Pin, Plus } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChatSummary, Project, UpdateChatInput } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { ConversationActions } from "./conversation-actions";
import { Button, Field, Input, Modal, Notice, Select, Spinner } from "./ui";

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

export function ProjectPage({ project, chats, creating, updating, onCreate, onSelect, onMove, onRename, onUpdate, settings }: {
  settings?: ReactNode;
  project?: Project;
  chats: ChatSummary[];
  creating: boolean;
  updating: ReadonlySet<string>;
  onCreate: () => void;
  onSelect: (id: string) => void;
  onRename: (chat: ChatSummary) => void;
  onMove: (chat: ChatSummary) => void;
  onUpdate: (id: string, input: UpdateChatInput) => void;
}) {
  if (!project) return <div className="project-page"><h1>Project unavailable</h1><p className="text-muted">Choose a project from Conversations.</p></div>;
  const visible = chats.filter(chat => chat.projectId === project.id && !chat.archived);
  return <section className="project-page">
    <header className="project-page-header">
      <div><p className="eyebrow">{project.kind === "shared" ? "Shared project" : "Personal grouping"}</p><h1>{project.name}</h1></div>
      <Button disabled={creating || project.canParticipate === false} onClick={onCreate}>{creating ? <Spinner /> : <Plus />} New conversation</Button>
    </header>
    {settings}
    <p className="project-conversation-count">{visible.length} {visible.length === 1 ? "conversation" : "conversations"}</p>
    {visible.length ? <ul className="project-conversations">
      {visible.map(chat => <li key={chat.id}>
        <button className="project-conversation-link" onClick={() => onSelect(chat.id)} type="button">
          {chat.pinned ? <Pin size={14} aria-label="Pinned" /> : null}
          <span>{chat.title}</span>
          <time dateTime={new Date(chat.updatedAt).toISOString()}>{conversationDate(chat.updatedAt)}</time>
        </button>
        <ConversationActions chat={chat} busy={updating.has(chat.id)} onMove={onMove} onRename={onRename} onUpdate={onUpdate} />
      </li>)}
    </ul> : <div className="project-empty"><p>No conversations yet.</p><p>{project.kind === "shared" ? "Project members can start a conversation here. Existing conversations cannot be moved into shared projects." : "Start a conversation here, or move one from its actions menu."}</p></div>}
  </section>;
}

export function MoveConversationDialog({ chat, projects, onClose, onMove }: {
  chat: ChatSummary;
  projects: Project[];
  onClose: () => void;
  onMove: (id: string, projectId: string | null) => Promise<void>;
}) {
  const [destination, setDestination] = useState(chat.projectId ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Modal title="Move to project" description={chat.title} open onOpenChange={open => { if (!open && !busy) onClose(); }} finalFocus={() => document.getElementById("main-workspace")}>
    <form className="stack" onSubmit={async event => {
      event.preventDefault();
      setBusy(true); setError(null);
      try { await onMove(chat.id, destination || null); onClose(); }
      catch (error) { setError(errorMessage(error)); }
      finally { setBusy(false); }
    }}>
      <Field label="Project">{props => <Select {...props} value={destination} disabled={busy} onChange={event => setDestination(event.target.value)}>
        <option value="">Without a project</option>
        {projects.filter(project => project.kind !== "shared").map(project => <option key={project.id} value={project.id}>{project.name}</option>)}
      </Select>}</Field>
      {error ? <Notice>{error}</Notice> : null}
      <div className="button-row project-form-actions">
        <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || destination === (chat.projectId ?? "")}>{busy ? <Spinner label="Moving conversation" /> : null} Move conversation</Button>
      </div>
    </form>
  </Modal>;
}

function conversationDate(timestamp: number) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  today.setDate(today.getDate() - 1);
  if (date.toDateString() === today.toDateString()) return "Yesterday";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== today.getFullYear() ? { year: "numeric" as const } : {}) }).format(date);
}
