import { Archive, ArchiveRestore, Pin, Plus } from "lucide-react";
import { useRef, useState } from "react";
import type { ChatSummary, UpdateChatInput } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { statusLabels } from "../lib/chat";
import { SidebarSearch } from "./sidebar-search";
import { Button, IconButton, Notice, Spinner } from "./ui";

type ConversationSidebarProps = {
  chats: ChatSummary[];
  activeChatId?: string;
  search: string;
  onSearchChange: (value: string) => void;
  creating: boolean;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onUpdate: (id: string, input: UpdateChatInput) => Promise<void>;
};

export function ConversationSidebar({ chats, activeChatId, search, onSearchChange, creating, onSelect, onCreate, onUpdate }: ConversationSidebarProps) {
  const archiveToggle = useRef<HTMLButtonElement>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [updating, setUpdating] = useState<Set<string>>(() => new Set());
  const [error, setError] = useState<string | null>(null);
  const visible = chats.filter(chat => chat.archived === showArchived);
  const filtered = visible.filter(chat => chat.title.toLowerCase().includes(search.toLowerCase()));
  const archivedCount = chats.filter(chat => chat.archived).length;

  async function update(chat: ChatSummary, input: UpdateChatInput) {
    setError(null);
    setUpdating(current => new Set(current).add(chat.id));
    try {
      await onUpdate(chat.id, input);
      if (input.archived !== undefined) requestAnimationFrame(() => archiveToggle.current?.focus());
    }
    catch (error) { setError(errorMessage(error)); }
    finally { setUpdating(current => { const next = new Set(current); next.delete(chat.id); return next; }); }
  }

  return <div className="collection-sidebar">
    <Button className="sidebar-create" onClick={() => { setShowArchived(false); onCreate(); }} disabled={creating}>{creating ? <Spinner /> : <Plus />} New chat</Button>
    <SidebarSearch label="Find a conversation" value={search} onChange={onSearchChange} />
    <div className="sidebar-list-heading">
      <h2>{showArchived ? "Archived" : "Conversations"}</h2>
      <span>{visible.length}</span>
    </div>
    {error ? <Notice>{error}</Notice> : null}
    <nav className="sidebar-list" aria-label={showArchived ? "Archived conversations" : "Saved conversations"}>
      {filtered.map(chat => <div key={chat.id} className={`sidebar-row ${chat.id === activeChatId ? "selected" : ""} ${chat.pinned ? "is-pinned" : ""}`}>
        <button type="button" className="sidebar-select" onClick={() => onSelect(chat.id)} aria-current={chat.id === activeChatId ? "page" : undefined} title={chat.title}>
          <span>{chat.title}</span>
          {chat.pinned ? <span className="sr-only">Pinned</span> : null}
          <span className={`conversation-dot dot-${chat.status}`} aria-label={statusLabels[chat.status]} />
        </button>
        <div className="sidebar-row-actions">
          <IconButton className="conversation-pin" label={`${chat.pinned ? "Unpin" : "Pin"} conversation: ${chat.title}`} disabled={updating.has(chat.id)} onClick={() => void update(chat, { pinned: !chat.pinned })}>
            <Pin size={15} fill={chat.pinned ? "currentColor" : "none"} />
          </IconButton>
          <IconButton label={`${chat.archived ? "Restore" : "Archive"} conversation: ${chat.title}`} disabled={updating.has(chat.id)} onClick={() => void update(chat, { archived: !chat.archived })}>
            {chat.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
          </IconButton>
        </div>
      </div>)}
      {!filtered.length ? <p className="sidebar-empty">{search ? "No conversations match your search." : showArchived ? "No archived conversations." : "Your conversations will appear here."}</p> : null}
    </nav>
    <Button ref={archiveToggle} variant="ghost" className="sidebar-archive-toggle" onClick={() => setShowArchived(value => !value)}>
      <Archive size={16} /> {showArchived ? "Back to conversations" : `Archived conversations (${archivedCount})`}
    </Button>
  </div>;
}
