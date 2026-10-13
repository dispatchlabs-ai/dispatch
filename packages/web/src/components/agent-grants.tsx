import { Link } from "react-router";
import { SkillLibraryAccess } from "./skill-library-access";
import { useApprovedConnections } from "../lib/approved-connections";
import { useRef, useState } from "react";
import type { AgentDefinition } from "../shared/contracts";
import { useAgentGrants, type GrantRequest, type ManagementGrant, type ManagementPolicy } from "../lib/agent-grants";
import { ApiError, errorMessage } from "../lib/api";
import { Button, Field, Input, Notice, Select, Spinner } from "./ui";

const fields = [["instructions", "Instructions"], ["provider", "Provider"], ["modelId", "Model"], ["thinkingLevel", "Thinking"], ["skills", "Skills"], ["capabilities", "Capabilities"], ["connections", "Connections"]] as const;
type Draft = { targetId: string; policy: ManagementPolicy | null; reason: string; version: number };

export function AgentGrants({ agent, busy, onBusy }: { agent: AgentDefinition; busy: boolean; onBusy: (busy: boolean) => void }) {
  const state = useAgentGrants(agent.id);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [inspectingDelegation, setInspectingDelegation] = useState(false);
  const catalog = useApprovedConnections(inspectingDelegation || Boolean(draft?.policy?.action === "save" && draft.policy.fields.includes("connections")));
  const [libraryEditing, setLibraryEditing] = useState(false);
  const allowedConnection = (id: string, targetId: string) => !catalog.error && !catalog.loading && (catalog.connections?.some(connection => connection.id === id && connection.canManage && connection.authorization === "authorized" && connection.usedBy.every(owner => owner.id === targetId)) ?? false);
  const connectionName = (id: string, targetId: string) => `${catalog.connections?.find(connection => connection.id === id)?.name ?? `Connection ${id}`}${allowedConnection(id, targetId) ? "" : catalog.error || catalog.loading || !catalog.connections ? " (availability unknown)" : " (unavailable for your account)"}`;

  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [pending, setPending] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reviewed, setReviewed] = useState(false);
  const [retry, setRetry] = useState<GrantRequest | null>(null);
  const origin = useRef<HTMLElement | null>(null);
  const formHeading = useRef<HTMLHeadingElement>(null);
  const eligible = state.agents.filter(item => !item.archived);
  const name = (id: string) => state.agents.find(item => item.id === id)?.name ?? `Unavailable agent (${id})`;
  const current = state.grants?.find(item => item.targetId === draft?.targetId);
  function open(grant: ManagementGrant | undefined, revoke: boolean, control: HTMLElement) {
    origin.current = control;
    setDraft({ targetId: grant?.targetId ?? eligible[0]?.id ?? "", version: grant?.version ?? 0, reason: "", policy: revoke ? null : grant?.policy ? { ...grant.policy, fields: [...grant.policy.fields], editorRevision: agent.revision } : { editorRevision: agent.revision, action: "save", fields: ["instructions"], maxSavesPerHour: 5 } });
    setError(""); setSuccess(""); setConflict(false); setRetry(null); setReviewed(false);
    requestAnimationFrame(() => formHeading.current?.focus());
  }
  function close() {
    setDraft(null); setRetry(null); setError(""); setConflict(false);
    requestAnimationFrame(() => origin.current?.focus());
  }
  async function submit() {
    if (!draft || pending || busy || libraryEditing) return;
    const policy = draft.policy?.action === "read" ? { ...draft.policy, fields: [], approvedConnectionIds: [], maxSavesPerHour: 5 } : draft.policy;
    const input = retry ?? { editorId: agent.id, targetId: draft.targetId, expectedVersion: draft.version, requestId: crypto.randomUUID(), reason: draft.reason.trim(), policy };
    setReviewed(false); setPending(true); onBusy(true); setError(""); setSuccess("");
    try {
      await state.save(input);
      close(); setSuccess(input.policy ? "Access saved and confirmed." : "Access revoked and confirmed.");
    } catch (cause) {
      setError(errorMessage(cause));
      if (cause instanceof ApiError && cause.status >= 400 && cause.status < 500) {
        setRetry(null); setConflict(cause.status === 409);
      } else {
        setRetry(input);
      }
    } finally { setPending(false); onBusy(false); }
  }
  const locked = busy || libraryEditing || pending || Boolean(retry);
  const valid = draft && draft.targetId && draft.reason.trim() && draft.reason.length <= 2000 && (!draft.policy || (
    !agent.archived && draft.policy.editorRevision === agent.revision && eligible.some(item => item.id === draft.targetId) && (
      draft.policy.action === "read" || (
        draft.policy.fields.length > 0 && Number.isInteger(draft.policy.maxSavesPerHour) && draft.policy.maxSavesPerHour >= 1 && draft.policy.maxSavesPerHour <= 100 &&
        (!draft.policy.approvedConnectionIds?.length || (!catalog.error && draft.policy.approvedConnectionIds.every(id => allowedConnection(id, draft.targetId))))
      )
    )
  ));
  return <section className="agent-access" aria-label="Agent access" onKeyDown={event => {
    // This section lives inside the definition form; Enter must not save a revision.
    if (event.key === "Enter" && event.target instanceof HTMLInputElement) event.preventDefault();
  }}>
    <header className="agent-access-heading"><div><h2>Agent access</h2><p>{agent.name} · saved editor rev {agent.revision}</p></div><Button type="button" variant="secondary" disabled={busy || libraryEditing || pending || Boolean(draft) || state.loading || Boolean(state.error) || agent.archived || !eligible.length} onClick={event => open(undefined, false, event.currentTarget)}>Add access</Button></header>
    <p>Grant and revoke actions apply immediately. Discard only affects agent edits.</p>
    <p className="field-hint">Grants stay in effect until revoked, including after edits to either agent.</p>
    {state.loading ? <Spinner label="Loading agent access" /> : null}
    {state.error ? <Notice>{state.error} <Button type="button" variant="secondary" disabled={pending} onClick={() => void state.refresh()}>Reload access</Button></Notice> : null}
    {success ? <Notice tone="success">{success}</Notice> : null}
    {state.grants && !state.grants.some(item => item.policy) ? <p>No access granted.</p> : null}
    <div>{state.grants?.filter(item => item.policy).map(grant => <div className="agent-access-row" key={grant.targetId}><div><strong>{name(grant.targetId)}</strong><p>{describe(grant.policy)}</p>{grant.policy!.action === "save" && grant.policy!.fields.includes("connections") ? <details className="agent-access-delegation" onToggle={event => { if (event.currentTarget.open) setInspectingDelegation(true); }}><summary>Approved connections ({grant.policy!.approvedConnectionIds?.length ?? 0})</summary><Button type="button" variant="secondary" disabled={catalog.loading || pending} onClick={() => void catalog.refresh()}>Refresh connection names</Button>{catalog.error ? <Notice>{catalog.error}</Notice> : null}{grant.policy!.approvedConnectionIds?.length ? <ul>{grant.policy!.approvedConnectionIds.map(id => <li key={id}>{connectionName(id, grant.targetId)}</li>)}</ul> : <p>No new assignments allowed. Existing connections must still be available.</p>}</details> : null}</div><div className="button-row"><Button type="button" variant="secondary" disabled={busy || libraryEditing || pending || Boolean(draft) || state.loading || Boolean(state.error) || agent.archived || !eligible.some(item => item.id === grant.targetId)} onClick={event => open(grant, false, event.currentTarget)}>Edit</Button><Button type="button" variant="danger" disabled={busy || libraryEditing || pending || Boolean(draft) || state.loading || Boolean(state.error)} onClick={event => open(grant, true, event.currentTarget)}>Revoke</Button></div></div>)}</div>
    {draft ? <div className="agent-access-form">
      <h3 ref={formHeading} tabIndex={-1}>{draft.policy ? "Grant access" : `Revoke access to ${name(draft.targetId)}`}</h3>
      {draft.policy ? <><div className="agent-access-grid"><Field label="Agent">{props => <Select {...props} disabled={locked || draft.version > 0} value={draft.targetId} onChange={event => { const grant = state.grants?.find(item => item.targetId === event.target.value); setDraft({ ...draft, targetId: event.target.value, version: grant?.version ?? 0 }); }}><option value="">Select an agent</option>{eligible.map(item => <option key={item.id} value={item.id}>{item.name}{item.id === agent.id ? " (self)" : ""}</option>)}</Select>}</Field>
      <Field label="Access">{props => <Select {...props} disabled={locked} value={draft.policy!.action} onChange={event => setDraft({ ...draft, policy: { ...draft.policy!, action: event.target.value as "read" | "save" } })}><option value="read">Read only</option><option value="save">Edit</option></Select>}</Field></div>
      <p className="field-hint">Read access exposes tuning settings, skill selections, capabilities and managed connection IDs. Editable fields restrict writes, not reads.</p>
      {draft.targetId === agent.id ? <p className="field-hint">Self-access is not approval. Each self-improvement needs manager approval.</p> : null}
      {draft.policy.action === "save" ? <><fieldset disabled={locked} className="agent-access-fields"><legend>Editable fields</legend>{fields.map(([key, label]) => <label key={key}><input type="checkbox" checked={draft.policy!.fields.includes(key)} onChange={event => setDraft({ ...draft, policy: { ...draft.policy!, fields: event.target.checked ? [...draft.policy!.fields, key] : draft.policy!.fields.filter(item => item !== key), ...(key === "connections" && !event.target.checked ? { approvedConnectionIds: [] } : {}) } })} />{label}</label>)}</fieldset>
      {draft.policy.fields.includes("skills") ? <p className="field-hint">Skill assignments only. Library editing is separate.</p> : null}
      {draft.policy.fields.includes("connections") ? <fieldset disabled={locked} className="agent-access-connections"><legend>Approved connections</legend><Button type="button" variant="secondary" disabled={locked || catalog.loading} onClick={() => void catalog.refresh()}>Refresh connections</Button>
        <p className="field-hint">Allows new assignments; does not connect now. Saving rechecks connection ownership and authorization for your account.</p>
        {catalog.error ? <Notice>{catalog.error} <Button type="button" variant="secondary" disabled={pending} onClick={() => void catalog.refresh()}>Reload connections</Button></Notice> : !catalog.connections ? <Spinner label="Loading approved connection choices" /> : null}
        {catalog.connections?.filter(connection => allowedConnection(connection.id, draft.targetId)).map(connection => <label className="agent-access-connection-choice" key={connection.id}><input type="checkbox" checked={draft.policy!.approvedConnectionIds?.includes(connection.id) ?? false} onChange={event => setDraft({ ...draft, policy: { ...draft.policy!, approvedConnectionIds: event.target.checked ? [...(draft.policy!.approvedConnectionIds ?? []), connection.id] : draft.policy!.approvedConnectionIds!.filter(id => id !== connection.id) } })} />{connection.name}</label>)}
        {(draft.policy.approvedConnectionIds ?? []).filter(id => !allowedConnection(id, draft.targetId)).map(id => <div className="agent-access-unavailable" key={id}><span>{connectionName(id, draft.targetId)}</span><Button type="button" variant="secondary" onClick={() => setDraft({ ...draft, policy: { ...draft.policy!, approvedConnectionIds: draft.policy!.approvedConnectionIds!.filter(item => item !== id) } })}>Remove</Button></div>)}
        {!catalog.error && catalog.connections && !catalog.connections.some(connection => allowedConnection(connection.id, draft.targetId)) ? <p>No eligible connections. <Link to="/?section=connections" target="_blank" rel="noopener noreferrer">Settings → Connections</Link></p> : null}
        {!draft.policy.approvedConnectionIds?.length ? <p className="field-hint">No new assignments allowed. The agent can keep or remove currently available connections.</p> : null}
      </fieldset> : null}
      <Field label="Saves / hour" hint="1–100">{props => <Input {...props} type="number" min={1} max={100} step={1} disabled={locked} value={draft.policy!.maxSavesPerHour} onChange={event => setDraft({ ...draft, policy: { ...draft.policy!, maxSavesPerHour: Number(event.target.value) } })} />}</Field></> : null}
      </> : null}
      <Field label="Reason" hint="Required for grant, edit and revocation.">{props => <Input {...props} maxLength={2000} disabled={locked} value={draft.reason} onChange={event => setDraft({ ...draft, reason: event.target.value })} />}</Field>
      {error ? <Notice>{error}</Notice> : null}
      {retry ? <Notice tone="info">The outcome could not be confirmed. Inputs are preserved. Review latest, then retry the identical request.</Notice> : null}
      {conflict || retry ? <><Button type="button" variant="secondary" disabled={pending || state.loading} onClick={() => void state.refresh().then(setReviewed)}>Review latest</Button><p>Latest: {current ? `${describe(current.policy)} · grant version ${current.version}` : "No grant"}. Your draft is unchanged.</p>{conflict ? <Button type="button" variant="secondary" disabled={!reviewed || pending || state.loading || Boolean(state.error)} onClick={() => { setDraft({ ...draft, version: current?.version ?? 0, policy: draft.policy ? { ...draft.policy, editorRevision: agent.revision } : null }); setConflict(false); setError(""); }}>Use latest version with my draft</Button> : null}</> : null}
      <div className="button-row"><Button type="button" variant="secondary" disabled={pending || busy} onClick={close}>Cancel</Button><Button type="button" variant={draft.policy ? "primary" : "danger"} disabled={pending || busy || state.loading || Boolean(state.error) || conflict || (Boolean(retry) && !reviewed) || (!retry && !valid)} onClick={() => void submit()}>{pending ? <Spinner label="Saving access" /> : null}{retry ? "Retry identical request" : draft.policy ? "Grant access" : "Revoke"}</Button></div>
    </div> : null}
    <SkillLibraryAccess agent={agent} disabled={busy || pending || Boolean(draft)} onBusy={onBusy} onEditing={setLibraryEditing} />
  </section>;
}
function describe(policy: ManagementPolicy | null) {
  if (!policy) return "Revoked";
  return policy.action === "read" ? "Read only" : `Edit · ${policy.fields.map(key => fields.find(([field]) => field === key)?.[1]).join(", ") || "No editable fields"} · ${policy.maxSavesPerHour} saves/h`;
}
