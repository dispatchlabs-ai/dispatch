import { flushSync } from "react-dom";
import { useEffect, useRef, useState } from "react";
import type { EvaluationProfile, EvaluationProfileDraft, EvaluationProfileResponse, SaveEvaluationProfileInput } from "../shared/evaluations";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Notice, Select, Spinner } from "./ui";
import { EvaluationFields, type EvaluationSection } from "./evaluation-fields";

const emptyDraft: EvaluationProfileDraft = { responsibilities: "", expectedBehavior: "", prohibitedActions: "", criteria: [], cases: [] };
function draftOf(profile: EvaluationProfile | null): EvaluationProfileDraft {
  if (!profile) return structuredClone(emptyDraft);
  const { responsibilities, expectedBehavior, prohibitedActions, criteria, cases } = profile;
  return structuredClone({ responsibilities, expectedBehavior, prohibitedActions, criteria, cases });
}

export function AgentEvaluation({ agentId, readOnly, onGuardChange, onClose, onContextChange, active }: {
  active: boolean;
  onClose: () => void;
  onContextChange: (context: React.ReactNode) => void;
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
  const headingRef = useRef<HTMLHeadingElement>(null);
  const loaded = data !== null;
  useEffect(() => { if (active) headingRef.current?.focus(); }, [active, loaded]);
  const formRef = useRef<HTMLFormElement>(null);
  const [section, setSection] = useState<EvaluationSection>("Expectations");
  const [selectedCase, setSelectedCase] = useState<string | null>(null);
  function revealField(target: HTMLElement) {
    const group = target.closest<HTMLElement>("[data-evaluation-section]")?.dataset.evaluationSection as EvaluationSection | undefined;
    const caseId = target.closest<HTMLElement>("[data-case-id]")?.dataset.caseId;
    flushSync(() => { if (group) setSection(group); if (caseId) setSelectedCase(caseId); });
    let parent = target.parentElement;
    while (parent) { if (parent instanceof HTMLDetailsElement) parent.open = true; parent = parent.parentElement; }
    target.focus();
  }
  const [saved, setSaved] = useState(false);
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
    if (missingCriteria) {
      const cases = formRef.current?.querySelectorAll<HTMLElement>(".evaluation-case");
      const target = cases?.[draft.cases.indexOf(missingCriteria)]?.querySelector<HTMLInputElement>(".evaluation-criteria input");
      if (target) revealField(target);
      setError(`Select at least one applicable criterion for case "${missingCriteria.name || "Unnamed case"}".`); return; }
    setBusy(true); setError(null); setConflict(false);
    const body = { ...draft, expectedRevision: data?.profile?.revision ?? null, changeReason: reason };
    const fingerprint = JSON.stringify(body);
    if (retry.current?.fingerprint !== fingerprint) retry.current = { fingerprint, requestId: crypto.randomUUID() };
    const input: SaveEvaluationProfileInput = { ...body, requestId: retry.current.requestId };
    try {
      const { profile } = await api<{ profile: EvaluationProfile }>(endpoint, input);
      setData({ profile, revisions: [{ revision: profile.revision, updatedAt: profile.updatedAt, savedBy: profile.savedBy, changeReason: profile.changeReason }, ...(data?.revisions ?? [])] });
      setDraft(null); setReason(""); setHistorical(null); setSaved(true);
    } catch (err) { setError(errorMessage(err)); setConflict(err instanceof ApiError && err.status === 409); }
    finally { setBusy(false); }
  }
  const displayed = historical ?? data?.profile;
  useEffect(() => {
    onContextChange(<>
      <h3>Evaluation definitions</h3>
      <p className="field-hint">Agent instructions unchanged.</p>
              <Field label="Profile revision">{props => <Select {...props} disabled={busy || !!draft || !displayed} value={displayed?.revision ?? ""} onChange={event => {
          const control = event.currentTarget;
          const revision = Number(control.value);
          if (revision === data?.profile?.revision) { setHistorical(null); return; }
          setBusy(true); setError(null);
          void api<{ profile: EvaluationProfile }>(`${endpoint}/revisions/${revision}`).then(value => setHistorical(value.profile)).catch(err => setError(errorMessage(err))).finally(() => { setBusy(false); requestAnimationFrame(() => { if (control.isConnected && document.activeElement === document.body) control.focus(); }); });
        }}>{data?.revisions.map(item => <option key={item.revision} value={item.revision}>Revision {item.revision}</option>)}</Select>}</Field>
      <dl className="context-facts"><div><dt>Execution</dt><dd>Not available yet</dd></div></dl>
      {displayed?.changeReason ? <><h3>Revision note</h3><p className="context-description">{displayed.changeReason}</p></> : null}
    </>);
    return () => onContextChange(null);
  }, [displayed, data, busy, !!draft, api, endpoint, onContextChange]);
  const introduction = <>
    <div className="evaluation-heading"><Button variant="ghost" disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard evaluation changes?")) { setDraft(null); setReason(""); setError(null); setConflict(false); onClose(); } }}>Back to agent</Button><span className="revision-badge">{draft ? "Editing" : displayed ? `Revision ${displayed.revision}` : data ? "Not configured" : "Loading"}</span></div>
    <h2 ref={headingRef} className="evaluation-intro" tabIndex={-1}>Evaluation profile</h2>
    <p className="field-hint evaluation-boundary">Agent instructions stay unchanged.</p>
  </>;
  return <section className="agent-evaluation">
    {saved && !draft ? <p role="status" className="evaluation-save-status">Profile saved. No evaluation was run.</p> : null}
    {error ? <Notice>{error}</Notice> : null}
    {!data ? <div className="evaluation-overview">{introduction}{error ? <Button variant="secondary" disabled={busy} onClick={() => void reload()}>Retry</Button> : <Spinner />}</div> : draft ? <form ref={formRef} noValidate onSubmit={event => {
      event.preventDefault();
      const invalid = Array.from(event.currentTarget.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input, textarea, select")).find(field => field.willValidate && !field.validity.valid);
      if (invalid) { revealField(invalid); invalid.reportValidity(); return; }
      void save();
    }}>
      <div className="evaluation-form-scroll">
      {introduction}

      {readOnly ? <Notice tone="info">Archived agent. Draft retained; saving unavailable.</Notice> : null}
      <EvaluationFields draft={draft} onChange={setDraft} disabled={busy || readOnly} section={section} onSectionChange={setSection} selectedCase={selectedCase} onCaseChange={setSelectedCase} />
      {conflict ? <Notice tone="info">Conflict. Draft preserved.</Notice> : null}
      </div>
      <div className="button-row evaluation-actions">
        <Field label="Change reason *">{props => <input {...props} required maxLength={1000} value={reason} disabled={busy || readOnly} placeholder="Why are you changing this profile?" onChange={event => setReason(event.target.value)} />}</Field>
        <span className="field-hint">{dirty ? "Unsaved changes" : "No changes"}</span>
        <Button variant="secondary" disabled={busy} onClick={() => { if (!dirty || window.confirm("Discard evaluation changes?")) { setDraft(null); setReason(""); setError(null); setConflict(false); } }}>Cancel</Button>
        {conflict ? <Button variant="secondary" disabled={busy} onClick={() => { if (window.confirm("Discard this draft and load the latest profile?")) void reload(); }}>Reload latest</Button> : <Button type="submit" disabled={busy || readOnly || !dirty || !draft.criteria.length}>{busy ? <Spinner /> : null}Save profile</Button>}
      </div>
    </form> : <>
      <div className="evaluation-overview">
      {introduction}
      {displayed ? <>
        <nav className="evaluation-section-links" aria-label="Saved evaluation sections">
          <a href="#saved-expectations">Expectations</a><a href="#saved-criteria">Grading criteria ({displayed.criteria.length})</a><a href="#saved-cases">Cases ({displayed.cases.length})</a>
        </nav>
        <details className="evaluation-saved-expectations" id="saved-expectations"><summary><strong>Expectations</strong><span className="field-hint">{displayed.responsibilities.slice(0, 140)}{displayed.responsibilities.length > 140 ? "…" : ""}</span><span className="evaluation-disclosure-label"><span className="expectations-closed-label">Show all expectations</span><span className="expectations-open-label">Collapse expectations</span></span></summary>
        <dl className="evaluation-summary">
          <dt>Responsibilities</dt><dd>{displayed.responsibilities}</dd>
          <dt>Expected behavior</dt><dd>{displayed.expectedBehavior}</dd>
          <dt>Prohibited actions</dt><dd>{displayed.prohibitedActions || "None specified"}</dd>
        </dl>
        </details>

        <h3 id="saved-criteria">Grading criteria</h3>
        {displayed.criteria.map(criterion => <details className="evaluation-saved-item" key={criterion.id}>
          <summary>{criterion.description}</summary>
          <p>{criterion.gradingMethod === "direct" ? "Direct check" : criterion.gradingMethod === "judge" ? "Judge" : "Human review"}{criterion.criticalFailure ? " · Critical failure" : ""}</p>
          <p className="evaluation-text">{criterion.gradingGuidance || "No grading guidance."}</p>
        </details>)}
        <h3 id="saved-cases">Cases</h3>
        {!displayed.cases.length ? <p className="field-hint">No standalone cases.</p> : displayed.cases.map(item => <details className="evaluation-saved-item" key={item.id}>
          <summary>{item.name}{!item.enabled ? " (disabled)" : ""}</summary>
          <dl className="evaluation-summary"><dt>Prompt</dt><dd>{item.prompt}</dd><dt>Starting conditions</dt><dd>{item.startingConditions || "None specified"}</dd><dt>Expected outcome</dt><dd>{item.expectedOutcome}</dd><dt>Applicable criteria</dt><dd>{item.criterionIds.map(id => displayed.criteria.find(criterion => criterion.id === id)?.description).join("; ") || "None selected"}</dd></dl>
          {item.inputArtifacts.map((artifact, index) => <div className="evaluation-artifact" key={index}><strong>{artifact.name}</strong><p className="evaluation-text">{artifact.reference}</p><p className="evaluation-text">{artifact.sha256}</p></div>)}
          <details className="evaluation-private"><summary>Evaluator-only material</summary><dl className="evaluation-summary"><dt>Grading guidance</dt><dd>{item.gradingGuidance || "None specified"}</dd><dt>Reference answer</dt><dd>{item.evaluatorOnly.referenceAnswer || "None specified"}</dd><dt>Checks</dt><dd>{item.evaluatorOnly.checks || "None specified"}</dd></dl></details>
        </details>)}

      </> : <div className="evaluation-empty"><h3>No evaluation profile yet</h3><p>Define expectations, grading criteria and cases.</p></div>}
      </div>
      <div className="evaluation-actions button-row">
      {!readOnly ? <Button variant={data.profile ? "secondary" : "primary"} disabled={busy} onClick={() => { setHistorical(null); setSaved(false); setDraft(draftOf(data.profile)); setSection("Expectations"); setSelectedCase(null); setReason(""); setError(null); }}> {data.profile ? "Edit profile" : "Create evaluation profile"}</Button> : null}
      </div>
    </>}
  </section>;
}
