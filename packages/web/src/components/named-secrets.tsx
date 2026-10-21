import { useEffect, useState } from "react";
import type { NamedSecret } from "../shared/secrets";
import { useSession } from "../lib/session";
import { errorMessage } from "../lib/api";
import { Button, Field, Input, Notice, Spinner } from "./ui";

export function NamedSecrets({ agentId, disabled = false }: { agentId?: string; disabled?: boolean }) {
  const { api } = useSession();
  const [secrets, setSecrets] = useState<NamedSecret[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [editing, setEditing] = useState<NamedSecret | null>(null);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    void api<{ secrets: NamedSecret[] }>("/api/secrets", undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setSecrets(result.secrets); setError(""); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, attempt]);
  async function change(action: () => Promise<unknown>) {
    setBusy(true); setError("");
    try { await action(); setAttempt(n => n + 1); }
    catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  function reset() { setEditing(null); setName(""); setValue(""); }
  return <section className={agentId ? "agent-connections" : "connection-card"}>
    <h2>{agentId ? "Secrets" : "Named secrets"}</h2>
    {error ? <Notice tone="error">{error}<Button variant="ghost" disabled={busy} onClick={() => setAttempt(n => n + 1)}>Reload</Button></Notice> : null}
    {!secrets && !error ? <p><Spinner /> Loading secrets…</p> : null}
    {agentId ? <>
      <p className="field-hint">Changes apply immediately to current and future instances. Shared workers are not isolated.</p>
      {secrets?.length === 0 ? <p>Create secrets in Settings → Secrets.</p> : null}
      {secrets?.map(secret => <label className="choice-row capability-choice" key={secret.id}>
        <input type="checkbox" disabled={busy || disabled} checked={secret.agentIds.includes(agentId)} onChange={event => {
          const granted = event.target.checked;
          void change(() => api(`/api/agents/${encodeURIComponent(agentId)}/secrets/${encodeURIComponent(secret.id)}`, { revision: secret.revision, granted }));
        }} /><span>{secret.name}</span>
      </label>)}
    </> : <>
      {secrets?.map(secret => <div className="connection-heading" key={secret.id}>
        <span>{secret.name}</span><div className="button-row">
          <Button variant="ghost" disabled={busy} onClick={() => { if ((name || value) && !window.confirm("Discard this secret draft?")) return; setEditing(secret); setName(secret.name); setValue(""); }}>Edit</Button>
          <Button variant="ghost" disabled={busy} onClick={() => { if (window.confirm(`Delete ${secret.name} and all its grants?`)) void change(async () => { await api(`/api/secrets/${encodeURIComponent(secret.id)}/delete`, { revision: secret.revision }); if (editing?.id === secret.id) reset(); }); }}>Delete</Button>
        </div>
      </div>)}
      <form onSubmit={event => { event.preventDefault(); void change(async () => {
        await api(editing ? `/api/secrets/${encodeURIComponent(editing.id)}` : "/api/secrets", { name, revision: editing?.revision ?? 0, ...(value ? { value } : {}) }); reset();
      }); }}>
        <Field label="Name">{props => <Input {...props} value={name} required maxLength={100} disabled={busy} onChange={event => setName(event.target.value)} />}</Field>
        <Field label={editing ? "Replace value" : "Value"} hint={editing ? "Leave blank to keep the saved value." : undefined}>{props => <Input {...props} type="password" autoComplete="new-password" value={value} required={!editing} maxLength={16384} disabled={busy} onChange={event => setValue(event.target.value)} />}</Field>
        <div className="button-row"><Button type="submit" disabled={busy}>{busy ? <Spinner /> : null}{editing ? "Save secret" : "Create secret"}</Button>{editing ? <Button variant="ghost" type="button" disabled={busy} onClick={reset}>Cancel</Button> : null}</div>
      </form>
    </>}
  </section>;
}
