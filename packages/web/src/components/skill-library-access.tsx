import { useRef, useState } from "react";
import type { AgentDefinition } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSkillLibraryGrant, type SkillLibraryGrantRequest, type SkillLibraryPolicy } from "../lib/skill-library-grants";
import { Button, Field, Input, Notice, Select, Spinner } from "./ui";

type Draft = { policy: SkillLibraryPolicy | null; reason: string; version: number };
export function SkillLibraryAccess({ agent, disabled, onBusy, onEditing }: {
  agent: AgentDefinition; disabled: boolean; onBusy: (busy: boolean) => void; onEditing: (editing: boolean) => void;
}) {
  const state = useSkillLibraryGrant(agent.id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [retry, setRetry] = useState<SkillLibraryGrantRequest | null>(null);
  const origin = useRef<HTMLElement | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  function open(revoke: boolean, control: HTMLElement) {
    origin.current = control;
    setDraft({ policy: revoke ? null : { ...(state.grant?.policy ?? { action: "read", maxSavesPerHour: 5 }), editorRevision: agent.revision }, reason: "", version: state.grant?.version ?? 0 });
    setError(""); setSuccess(""); setConflict(false); setReviewed(false); setRetry(null); onEditing(true);
    requestAnimationFrame(() => heading.current?.focus());
  }
  function close() {
    setDraft(null); setRetry(null); setError(""); setConflict(false); onEditing(false);
    requestAnimationFrame(() => origin.current?.focus());
  }
  async function submit() {
    if (!draft || pending || disabled) return;
    const policy = draft.policy?.action === "read" ? { ...draft.policy, maxSavesPerHour: 5 } : draft.policy;
    const input = retry ?? { editorId: agent.id, expectedVersion: draft.version, requestId: crypto.randomUUID(), reason: draft.reason.trim(), policy };
    setPending(true); onBusy(true); setError(""); setSuccess(""); setReviewed(false);
    try {
      await state.save(input);
      close(); setSuccess(input.policy ? "Library access saved and confirmed." : "Library access revoked and confirmed.");
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) { setRetry(null); setConflict(cause.status === 409); }
      else setRetry(input);
    } finally { setPending(false); onBusy(false); }
  }
  const locked = pending || disabled || Boolean(retry);
  const valid = draft && draft.reason.trim() && draft.reason.length <= 2000 && (!draft.policy || (!agent.archived && draft.policy.editorRevision === agent.revision && (draft.policy.action === "read" || (Number.isInteger(draft.policy.maxSavesPerHour) && draft.policy.maxSavesPerHour >= 1 && draft.policy.maxSavesPerHour <= 100))));
  return <section className="agent-access agent-library-access" aria-label="Skill library access">
    <header className="agent-access-heading"><h2>Skill library</h2><Button type="button" variant="secondary" disabled={disabled || pending || Boolean(draft) || state.loading || Boolean(state.error) || agent.archived} onClick={event => open(false, event.currentTarget)}>{state.grant?.policy ? state.grant.policy.editorRevision !== agent.revision ? "Renew library access" : "Edit library access" : "Add library access"}</Button></header>
    <p className="field-hint">Company skill library. Does not assign or delete skills.</p>
    {state.loading ? <Spinner label="Loading library access" /> : null}
    {state.error ? <Notice>{state.error} <Button type="button" variant="secondary" disabled={pending} onClick={() => void state.refresh()}>Reload library access</Button></Notice> : null}
    {!state.loading && !state.error && !state.grant?.policy ? <p>No library access.</p> : null}
    {state.grant?.policy ? <div className="agent-access-row"><div><p>{describe(state.grant.policy)}</p>{state.grant.policy.editorRevision !== agent.revision ? <strong>Needs renewal</strong> : null}</div><Button type="button" variant="danger" disabled={disabled || pending || Boolean(draft) || state.loading || Boolean(state.error)} onClick={event => open(true, event.currentTarget)}>Revoke library access</Button></div> : null}
    {success ? <Notice tone="success">{success}</Notice> : null}
    {draft ? <div className="agent-access-form">
      <h3 ref={heading} tabIndex={-1}>{draft.policy ? "Grant library access" : "Revoke library access"}</h3>
      {draft.policy ? <><div className="agent-access-grid"><Field label="Library access">{props => <Select {...props} disabled={locked} value={draft.policy!.action} onChange={event => setDraft({ ...draft, policy: { ...draft.policy!, action: event.target.value as "read" | "save" } })}><option value="read">Read only</option><option value="save">Create &amp; edit</option></Select>}</Field>
      {draft.policy.action === "save" ? <Field label="Library saves / hour" hint="1–100">{props => <Input {...props} type="number" min={1} max={100} step={1} disabled={locked} value={draft.policy!.maxSavesPerHour} onChange={event => setDraft({ ...draft, policy: { ...draft.policy!, maxSavesPerHour: Number(event.target.value) } })} />}</Field> : null}</div>
      <p className="field-hint">Uses editor rev {draft.policy.editorRevision}. Renew after definition changes, including self-saves.</p></> : null}
      <Field label="Library reason" hint="Required for grant, renewal and revocation.">{props => <Input {...props} maxLength={2000} disabled={locked} value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} />}</Field>
      {error ? <Notice>{error}</Notice> : null}
      {retry ? <Notice tone="info">Outcome not confirmed. Review latest, then retry the identical request.</Notice> : null}
      {conflict || retry ? <><Button type="button" variant="secondary" disabled={pending || state.loading} onClick={() => void state.refresh().then(setReviewed)}>Review latest library access</Button><p>Latest: {state.grant ? `${describe(state.grant.policy)} · grant version ${state.grant.version}` : "No library grant"}. Your draft is unchanged.</p>{conflict ? <Button type="button" variant="secondary" disabled={!reviewed || pending || state.loading || Boolean(state.error)} onClick={() => { setDraft({ ...draft, version: state.grant?.version ?? 0, policy: draft.policy ? { ...draft.policy, editorRevision: agent.revision } : null }); setConflict(false); setError(""); }}>Use latest library version with my draft</Button> : null}</> : null}
      <div className="button-row"><Button type="button" variant="secondary" disabled={pending || disabled} onClick={close}>Cancel library edit</Button><Button type="button" variant={draft.policy ? "primary" : "danger"} disabled={pending || disabled || state.loading || Boolean(state.error) || conflict || (Boolean(retry) && !reviewed) || (!retry && !valid)} onClick={() => void submit()}>{pending ? <Spinner label="Saving library access" /> : null}{retry ? "Retry identical library request" : draft.policy ? "Grant library access" : "Revoke library access"}</Button></div>
    </div> : null}
  </section>;
}
function describe(policy: SkillLibraryPolicy | null) {
  return policy ? `${policy.action === "save" ? `Create & edit · ${policy.maxSavesPerHour} saves/h` : "Read only"} · Editor rev ${policy.editorRevision}` : "Revoked";
}
