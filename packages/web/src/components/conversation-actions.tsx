import { Menu } from "@base-ui/react/menu";
import { Archive, ArchiveRestore, FolderInput, MoreHorizontal, Pencil, Pin } from "lucide-react";
import type { ChatSummary, UpdateChatInput } from "../shared/contracts";
import { IconButton } from "./ui";

export function ConversationActions({ chat, busy, onMove, onRename, onUpdate }: {
  chat: ChatSummary;
  busy: boolean;
  onRename: (chat: ChatSummary) => void;
  onMove: (chat: ChatSummary) => void;
  onUpdate: (id: string, input: UpdateChatInput) => void;
}) {
  return <Menu.Root>
    <Menu.Trigger render={<IconButton label={`Actions for ${chat.title}`} disabled={busy}><MoreHorizontal size={17} /></IconButton>} />
    <Menu.Portal>
      <Menu.Positioner className="menu-positioner" sideOffset={6} align="end" collisionPadding={12}>
        <Menu.Popup className="action-menu">
          <Menu.Item disabled={chat.canParticipate === false} onClick={() => onRename(chat)}><Pencil size={16} /> Rename chat</Menu.Item>
          {!chat.sharedProjectId ? <Menu.Item onClick={() => onMove(chat)}><FolderInput size={16} /> Move to personal grouping</Menu.Item> : null}
          <Menu.Item onClick={() => onUpdate(chat.id, { pinned: !chat.pinned })}><Pin size={16} /> {chat.pinned ? "Unpin" : "Pin"} chat</Menu.Item>
          <Menu.Item onClick={() => onUpdate(chat.id, { archived: !chat.archived })}>
            {chat.archived ? <ArchiveRestore size={16} /> : <Archive size={16} />}
            {chat.archived ? "Restore" : "Archive"} chat
          </Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
}
