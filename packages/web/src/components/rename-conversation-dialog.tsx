import { useState } from "react";
import type { ChatSummary } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { Button, Field, Input, Modal, Notice, Spinner } from "./ui";

export function RenameConversationDialog({ chat, onClose, onRename }: {
  chat: ChatSummary;
  onClose: () => void;
  onRename: (id: string, title: string) => Promise<void>;
}) {
  const [title, setTitle] = useState(chat.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Modal title="Rename conversation" description="Change the name shown in Dispatch for everyone in this conversation."
    open onOpenChange={open => { if (!open && !busy) onClose(); }}
    finalFocus={() => document.getElementById("main-workspace")}>
    <form className="stack" onSubmit={async event => {
      event.preventDefault();
      if (busy || !title.trim() || title.trim().length > 200) return;
      setBusy(true); setError(null);
      try { await onRename(chat.id, title.trim()); onClose(); }
      catch (error) { setError(errorMessage(error)); }
      finally { setBusy(false); }
    }}>
      <Field label="Conversation name" hint="Up to 200 characters.">{props => <Input {...props} value={title} required maxLength={200} disabled={busy}
        onChange={event => setTitle(event.target.value)} />}</Field>
      {error ? <Notice>{error}</Notice> : null}
      <div className="button-row">
        <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button type="submit" disabled={busy || !title.trim() || title.trim().length > 200}>{busy ? <Spinner label="Renaming conversation" /> : null} Save name</Button>
      </div>
    </form>
  </Modal>;
}
