import { useEffect, useRef, useState } from "react";
import type { EvaluationProfile, EvaluationProfileDraft, EvaluationProfileResponse, SaveEvaluationProfileInput } from "../shared/evaluations";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Notice, Select, Spinner } from "./ui";
import { EvaluationFields } from "./evaluation-fields";

const emptyDraft: EvaluationProfileDraft = { responsibilities: "", expectedBehavior: "", prohibitedActions: "", criteria: [], cases: [] };
function draftOf(profile: EvaluationProfile | null): EvaluationProfileDraft {
  if (!profile) return structuredClone(emptyDraft);
  const { responsibilities, expectedBehavior, prohibitedActions, criteria, cases } = profile;
  return structuredClone({ responsibilities, expectedBehavior, prohibitedActions, criteria, cases });
}

export function AgentEvaluation({ agentId, readOnly, onGuardChange }: {
  agentId: string; readOnly: boolean; onGuardChange: (guard: { dirty: boolean; busy: boolean }) => void;
}) {
  const { api } = useSession();
  const [data, setData] = useState<EvaluationProfileResponse | null>(null);
  const [draft, setDraft] = useState<EvaluationProfileDraft | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [historical, setHistorical] = useState<EvaluationProfile | null>(null);
  const retry = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const endpoint = `/api/agents/${encodeURIComponent(agentId)}/evaluation`;
  const dirty = draft !== null && (JSON.stringify(draft) !== JSON.stringify(draftOf(data?.profile ?? null)) || !!reason);
  useEffect(() => { onGuardChange({ dirty, busy }); return () => onGuardChange({ dirty: false, busy: false }); }, [dirty, busy, onGuardChange]);
  useEffect(() => {
    let current = true;
    void api<EvaluationProfileResponse>(endpoint).then(value => { if (current) setData(value); }).catch(err => { if (current) setError(errorMessage(err)); });
    return () => { current = false; };
  }, [api, endpoint]);
  async function reload() {
    setBusy(true); setError(null);
    try { setData(await api<EvaluationProfileResponse>(endpoint)); setDraft(null); setReason(""); setConflict(false); setHistorical(null); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  async function save() {
    if (!draft || readOnly || busy) return;
    const missingCriteria = draft.cases.find(item => !item.criterionIds.length);
    if (missingCriteria) { setError(`Select at least one applicable criterion for case "${missingCriteria.name || "Unnamed case"}".`); return; }
    setBusy(true); setError(null); setConflict(false);
    const body = { ...draft, expectedRevision: data?.profile?.revision ?? null, changeReason: reason };
    const fingerprint = JSON.stringify(body);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, requestId: crypto.randomUUID() };
    const input: SaveEvaluationProfileInput = { ...body, requestId: retry.current.requestId };
    try {
      const { profile } = await api<{ profile: EvaluationProfile }>(endpoint, input);
      setData({ profile, revisions: [{ revision: profile.revision, updatedAt: profile.updatedAt, savedBy: profile.savedBy, changeReason: profile.changeReason }, ...(data?.revisions ?? [])] });
      setDraft(null); setReason(""); setHistorical(null);
    } catch (err) { setError(errorMessage(err)); setConflict(err instanceof ApiError && err.status === 409); }
    finally { setBusy(false); }
  }
  const displayed = historical ?? data?.profile;
  return <section className="agent-evaluation">
    <div className="evaluation-heading"><h2>Evaluation profile</h2><span className="revision-badge">{draft ? "Editing" : displayed ? `Revision ${displayed.revision}` : data ? "Not configured" : "Loading"}</span></div>
    {error ? <Notice>{error}</Notice> : null}
    {!data ? error ? <Button variant="secondary" disabled={busy} onClick={() => void reload()}>Retry</Button> : <Spinner /> : draft ? <form onSubmit={event => { event.preventDefault(); void save(); }}>
      {readOnly ? <Notice tone="info">Archived agent. Draft retained; saving unavailable.</Notice> : null}
      <EvaluationFields draft={draft} onChange={setDraft} disabled={busy || readOnly} />
      <Field label="Change reason">{props => <textarea {...props} required maxLength={1000} rows={2} value={reason} disabled={busy || readOnly} onChange={event => setReason(event.target.value)} />}</Field>
      {conflict ? <Notice tone="info">Conflict. Draft preserved.</Notice> : null}
      <div className="button-row evaluation-actions">
        <Button variant="secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard evaluation changes?")) { setDraft(null); setReason(""); setError(null); setConflict(false); } }}>Discard</Button>
        {conflict ? <Button variant="secondary" disabled={busy} onClick={() => { if (window.confirm("Discard this draft and load the latest profile?")) void reload(); }}>Reload latest</Button> : <Button type="submit" disabled={busy || readOnly || !dirty || !draft.criteria.length}>{busy ? <Spinner /> : null}Save evaluation profile</Button>}
      </div>
    </form> : <>
      {displayed ? <>
        <p className="field-hint">{displayed.changeReason}</p>
        <dl className="evaluation-summary">
          <dt>Responsibilities</dt><dd>{displayed.responsibilities}</dd>
          <dt>Expected behavior</dt><dd>{displayed.expectedBehavior}</dd>
          <dt>Prohibited actions</dt><dd>{displayed.prohibitedActions || "None specified"}</dd>
        </dl>
        <h3>Criteria</h3>
        {displayed.criteria.map(criterion => <details className="evaluation-saved-item" key={criterion.id}>
          <summary>{criterion.description}</summary>
          <p>{criterion.gradingMethod === "direct" ? "Direct check" : criterion.gradingMethod === "judge" ? "Judge" : "Human review"}{criterion.criticalFailure ? " · Critical failure" : ""}</p>
          <p className="evaluation-text">{criterion.gradingGuidance || "No grading guidance."}</p>
        </details>)}
        <h3>Standalone cases</h3>
        {!displayed.cases.length ? <p className="field-hint">No standalone cases.</p> : displayed.cases.map(item => <details className="evaluation-saved-item" key={item.id}>
          <summary>{item.name}{!item.enabled ? " (disabled)" : ""}</summary>
          <dl className="evaluation-summary"><dt>Prompt</dt><dd>{item.prompt}</dd><dt>Starting conditions</dt><dd>{item.startingConditions || "None specified"}</dd><dt>Expected outcome</dt><dd>{item.expectedOutcome}</dd><dt>Applicable criteria</dt><dd>{item.criterionIds.map(id => displayed.criteria.find(criterion => criterion.id === id)?.description).join("; ") || "None selected"}</dd></dl>
          {item.inputArtifacts.map((artifact, index) => <div className="evaluation-artifact" key={index}><strong>{artifact.name}</strong><p className="evaluation-text">{artifact.reference}</p><p className="evaluation-text">{artifact.sha256}</p></div>)}
          <details className="evaluation-private"><summary>Evaluator-only material</summary><dl className="evaluation-summary"><dt>Grading guidance</dt><dd>{item.gradingGuidance || "None specified"}</dd><dt>Reference answer</dt><dd>{item.evaluatorOnly.referenceAnswer || "None specified"}</dd><dt>Checks</dt><dd>{item.evaluatorOnly.checks || "None specified"}</dd></dl></details>
        </details>)}
        <Field label="Profile revision">{props => <Select {...props} disabled={busy} value={displayed.revision} onChange={event => {
          const revision = Number(event.target.value);
          if (revision === data.profile?.revision) { setHistorical(null); return; }
          setBusy(true); setError(null);
          void api<{ profile: EvaluationProfile }>(`${endpoint}/revisions/${revision}`).then(value => setHistorical(value.profile)).catch(err => setError(errorMessage(err))).finally(() => setBusy(false));
        }}>{data.revisions.map(item => <option key={item.revision} value={item.revision}>Revision {item.revision}</option>)}</Select>}</Field>
      </> : <p className="field-hint">No evaluation profile.</p>}
      {!readOnly ? <Button variant="secondary" disabled={busy} onClick={() => { setHistorical(null); setDraft(draftOf(data.profile)); setReason(""); setError(null); }}> {data.profile ? "Edit evaluation profile" : "Configure evaluations"}</Button> : null}
    </>}
  </section>;
}
