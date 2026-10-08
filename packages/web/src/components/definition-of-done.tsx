import type { ChatSnapshot } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Markdown } from "./markdown";
import { Button, Field, Notice, Spinner } from "./ui";

export type CriteriaDraft = { markdown: string; revision: number; busy?: boolean; error?: string; conflict?: boolean };

export function DefinitionOfDone({ snapshot, draft, onDraft, onSnapshot }: {
  snapshot: ChatSnapshot; draft?: CriteriaDraft; onDraft: (draft: CriteriaDraft | undefined) => void; onSnapshot: (snapshot: ChatSnapshot) => void;
}) {
  const { api } = useSession();
  const saved = snapshot.definitionOfDone;
  const editable = snapshot.conversation.canParticipate !== false;
  const conflict = draft && (draft.conflict || draft.revision !== saved.revision);
  return <section className="stack" aria-label="Definition of Done">
    <h3>Definition of Done</h3>
    {saved.markdown ? <Markdown>{saved.markdown}</Markdown> : <p className="field-hint">No criteria set.</p>}
    {draft ? <form className="stack" onSubmit={async event => {
      event.preventDefault();
      if (draft.busy || conflict || !editable) return;
      onDraft({ ...draft, busy: true, error: undefined });
      try {
        const next = await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(snapshot.conversation.id)}/definition-of-done`, { markdown: draft.markdown, expectedRevision: draft.revision });
        onSnapshot(next); onDraft(undefined);
      } catch (error) {
        onDraft({ ...draft, error: errorMessage(error), conflict: true });
      }
    }}>
      <Field label="Completion criteria" hint="Markdown · 20,000 characters maximum">{props => <textarea {...props} rows={8} maxLength={20000} value={draft.markdown} disabled={draft.busy || !editable} onChange={event => onDraft({ ...draft, markdown: event.target.value })} />}</Field>
      {draft.error ? <Notice>{draft.error}</Notice> : null}
      {conflict ? <><Notice tone="info">Review saved criteria before retrying.</Notice><Button variant="secondary" disabled={draft.busy} onClick={async () => {
        onDraft({ ...draft, busy: true });
        try {
          const latest = await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(snapshot.conversation.id)}`);
          onSnapshot(latest); onDraft({ ...draft, busy: false, conflict: false, error: undefined, revision: latest.definitionOfDone.revision });
        } catch (error) { onDraft({ ...draft, error: errorMessage(error) }); }
      }}>Review latest; keep my draft</Button></> : null}
      <div className="button-row">
        <Button variant="secondary" disabled={draft.busy} onClick={() => { if (draft.markdown === saved.markdown || window.confirm("Discard criteria changes?")) onDraft(undefined); }}>Cancel</Button>
        <Button type="submit" disabled={draft.busy || Boolean(conflict) || !editable}>{draft.busy ? <Spinner /> : null} Save criteria</Button>
      </div>
    </form> : editable ? <Button variant="secondary" onClick={() => onDraft({ ...saved })}>{saved.markdown ? "Edit criteria" : "Set criteria"}</Button> : null}
  </section>;
}
