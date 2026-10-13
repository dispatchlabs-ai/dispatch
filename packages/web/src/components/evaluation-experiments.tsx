import { useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import type { AgentDefinition } from "../shared/contracts";
import type { AppendEvaluationResultInput, CreateEvaluationComparisonInput, CreateEvaluationComparisonResponse, EvaluationComparisonCaseView, EvaluationComparisonResponse, EvaluationEvidenceView, EvaluationProfileResponse, EvaluationResult, EvaluationVerdict, EvaluationVariantKind } from "../shared/evaluations";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Notice, Select, Spinner } from "./ui";

export function evaluationUrl(agentId: string, view = "profile", extra: Record<string, string> = {}) {
  return `/?${new URLSearchParams({ section: "agents", agent: agentId, eval: view, ...extra })}`;
}
const words = (value: string) => value.replaceAll("_", " ");
const exposureLabel = { tuning: "Tuning", previously_exposed_validation: "Previously exposed validation", held_out_clean: "Held-out clean" };
const variants: EvaluationVariantKind[] = ["baseline", "candidate"];
function Evidence({ items }: { items: EvaluationEvidenceView[] }) {
  return <ul className="eval-evidence">{items.map(item => <li key={item.ref}>{item.available && item.url ? <a href={item.url}>{item.label}</a> : <span>{item.label} · {item.available ? "Link unavailable" : "Unavailable"}</span>}{item.truncated ? " · Truncated" : ""}</li>)}</ul>;
}
function gate(item: EvaluationComparisonCaseView, variant: EvaluationVariantKind) {
  const entry = item.runs[variant];
  const rows = entry?.latestResult?.criteria ?? [];
  if (item.criteria.some(criterion => criterion.criticalFailure && rows.some(row => row.criterionId === criterion.criterionId && row.verdict === "fail"))) return "Blocked";
  if (!entry || !entry.latestResult || entry.latestResult.gradingStatus !== "completed" || !["completed", "failed", "cancelled"].includes(entry.run.status)) return "Unresolved";
  if (item.criteria.some(criterion => !rows.some(row => row.criterionId === criterion.criterionId) || (criterion.criticalFailure && rows.find(row => row.criterionId === criterion.criterionId)?.verdict !== "pass"))) return "Unresolved";
  return "Clear";
}

export function EvaluationExperiments({ agent, active }: { agent: AgentDefinition; active: boolean }) {
  const { api } = useSession();
  const [params, setParams] = useSearchParams();
  const view = params.get("eval") ?? "profile";
  const comparisonId = params.get("comparison");
  const runId = params.get("run");
  const [profile, setProfile] = useState<EvaluationProfileResponse | null>(null);
  const [data, setData] = useState<EvaluationComparisonResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [openId, setOpenId] = useState("");
  const [candidate, setCandidate] = useState(agent.instructions);
  const [baselineRevision, setBaselineRevision] = useState(agent.revision);
  const [selected, setSelected] = useState<string[]>([]);
  const [fixtures, setFixtures] = useState<Record<string, string>>({});
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const receipt = useRef<{ fingerprint: string; operationId: string } | null>(null);
  const judgmentDrafts = useRef<Record<string, JudgmentDraft>>({});
  const root = `/api/agents/${encodeURIComponent(agent.id)}/evaluation`;
  useEffect(() => {
    let current = true;
    void api<EvaluationProfileResponse>(root).then(value => { if (current) { setProfile(value); setSelected(value.profile?.cases.filter(item => item.enabled && item.split === "tuning").map(item => item.id) ?? []); } }).catch(err => { if (current) setError(errorMessage(err)); });
    return () => { current = false; };
  }, [api, root]);
  useEffect(() => {
    if (!active || !comparisonId) return;
    let current = true;
    setLoading(true); setError(null);
    void api<EvaluationComparisonResponse>(`${root}/comparisons/${encodeURIComponent(comparisonId)}`).then(value => { if (current) setData(value); }).catch(err => { if (current) setError(errorMessage(err)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [api, root, comparisonId, refresh, active]);
  // Refresh committed state only; retries never re-admit inference.
  useEffect(() => {
    if (!active || !data || data.comparison.id !== comparisonId || !data.cases.some(item => variants.some(variant => ["pending", "running"].includes(item.runs[variant]?.run.status ?? "")))) return;
    const timer = setTimeout(() => setRefresh(value => value + 1), 4000);
    return () => clearTimeout(timer);
  }, [active, data, comparisonId, refresh]);
  async function create() {
    if (!profile?.profile || busy) return;
    setBusy(true); setError(null);
    try {
      const fixtureInputs: CreateEvaluationComparisonInput["fixtures"] = {};
      for (const caseId of selected) {
        const scriptedMessages: unknown = scripts[caseId]?.trim() ? JSON.parse(scripts[caseId]) : [];
        if (!Array.isArray(scriptedMessages) || scriptedMessages.some(item => !item || typeof item.authorLabel !== "string" || typeof item.text !== "string")) throw new Error("Invalid scripted messages");
        fixtureInputs[caseId] = { fixtureId: fixtures[caseId] ?? "", scriptedMessages };
      }
      const body = { profileRevision: profile.profile.revision, expectedAgentRevision: baselineRevision, caseIds: selected, candidateInstructions: candidate, fixtures: fixtureInputs };
      const fingerprint = JSON.stringify(body);
      if (receipt.current?.fingerprint !== fingerprint) receipt.current = { fingerprint, operationId: crypto.randomUUID() };
      const result = await api<CreateEvaluationComparisonResponse>(`${root}/comparisons`, { ...body, operationId: receipt.current.operationId } satisfies CreateEvaluationComparisonInput);
      setParams(new URLSearchParams({ section: "agents", agent: agent.id, eval: "compare", comparison: result.comparisonId }));
    } catch (err) { setError(err instanceof SyntaxError || (err instanceof Error && err.message === "Invalid scripted messages") ? "Scripted messages must be a JSON array of { authorLabel, text } objects." : errorMessage(err)); }
    finally { setBusy(false); }
  }
  const displayed = data?.comparison.id === comparisonId ? data : null;
  const target = displayed?.cases.flatMap(item => variants.map(variant => ({ item, variant, entry: item.runs[variant] }))).find(value => value.entry?.run.id === runId);
  return <section className="eval-experiments" hidden={!active}>
    <nav className="evaluation-section-links" aria-label="Evaluation execution views">
      <Link to={evaluationUrl(agent.id, "new")}>New comparison</Link>
      {comparisonId ? <Link to={evaluationUrl(agent.id, "compare", { comparison: comparisonId })}>Compare</Link> : null}
      <Link to={evaluationUrl(agent.id)}>Profile</Link>
    </nav>
    {error ? <Notice>{error}</Notice> : null}
    {view === "new" ? <form onSubmit={event => { event.preventDefault(); void create(); }}>
      <h2>New comparison</h2>
      <Notice tone="info"><strong>Trusted local execution. Not sandboxed.</strong><br />Runs can use host tools and files. An independent fixture is required for each variant.</Notice>
      <p>Baseline revision {baselineRevision} · Profile revision {profile?.profile?.revision ?? "Unavailable"}. Candidate instructions replace baseline instructions only in this experiment; they are not saved or adopted.</p>
      {baselineRevision !== agent.revision ? <Notice>Agent revision changed to {agent.revision}. Your baseline remains pinned. <Button variant="secondary" disabled={busy} onClick={() => setBaselineRevision(agent.revision)}>Use current baseline revision</Button></Notice> : null}
      <div className="eval-create-grid"><Field label="Candidate instructions">{props => <textarea {...props} required value={candidate} disabled={busy} onChange={event => setCandidate(event.target.value)} rows={12} />}</Field>
      <fieldset disabled={busy} className="eval-manifest"><legend>Expected case × variant manifest</legend>
        {!profile ? <Spinner /> : !profile.profile ? <p>No profile configured. Create a profile before running cases.</p> : profile.profile.cases.map(item => <div key={item.id} className="eval-fixture-row">
          <label><input type="checkbox" checked={selected.includes(item.id)} onChange={event => setSelected(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} /> {item.name} · {item.split === "held_out" ? "Held out" : "Tuning"}</label>
          {selected.includes(item.id) ? <><Field label={`Fixture ID for ${item.name}`} hint="Operator-provisioned fixture. Checked on admission.">{props => <Input {...props} required value={fixtures[item.id] ?? ""} onChange={event => setFixtures(current => ({ ...current, [item.id]: event.target.value }))} />}</Field>
          <details><summary>Scripted fixture messages</summary><Field label={`Messages for ${item.name}`} hint="JSON array of authorLabel/text objects. These are fixture actors, not live teammates.">{props => <textarea {...props} rows={3} value={scripts[item.id] ?? ""} onChange={event => setScripts(current => ({ ...current, [item.id]: event.target.value }))} />}</Field></details>
          <p className="field-hint">Baseline: Planned · Candidate: Planned</p></> : null}
        </div>)}
      </fieldset></div>
      <Button type="submit" disabled={busy || agent.archived || !selected.length || !profile?.profile}>{busy ? "Submitting…" : "Run comparison"}</Button>
      {agent.archived ? <p>Archived agents cannot start new experiments.</p> : null}
    </form> : comparisonId ? <>
      <div className="eval-heading"><h2>{view === "judge" ? "Human judgment" : view === "history" ? "Judgment history" : "Compare"}</h2><Button variant="secondary" disabled={loading} onClick={() => setRefresh(value => value + 1)}>Refresh results</Button></div>
      {loading && !displayed ? <Spinner /> : null}
      {displayed ? <>
        <p>Baseline revision {displayed.comparison.agentRevision} · Candidate: unsaved instruction snapshot · Profile revision {displayed.comparison.profileRevision}</p>
        <details className="eval-run-details"><summary>Run details</summary><dl><dt>Candidate SHA-256</dt><dd>{displayed.comparison.candidateInstructionsSha256}</dd><dt>Comparison</dt><dd>{comparisonId}</dd></dl>{displayed.cases.map(item => <div key={item.caseId}><h3>{item.name} · {exposureLabel[item.exposure]}</h3>{variants.map(variant => <details key={variant}><summary>{words(variant)} configuration</summary><pre>{JSON.stringify(item.runs[variant]?.run ?? { status: "Missing run" }, null, 2)}</pre></details>)}</div>)}</details>
        {view === "judge" ? target?.entry ? <Judgment key={target.entry.run.id} item={target.item} entry={target.entry} root={root} drafts={judgmentDrafts.current} onSaved={() => setRefresh(value => value + 1)} /> : <Notice>Requested run is not available in this comparison.</Notice> : view === "history" ? target?.entry ? <div>{target.entry.results.length ? target.entry.results.map(result => <details key={result.id} open><summary>{new Date(result.createdAt).toLocaleString()} · {words(result.gradingStatus)}</summary><ResultRows result={result} evidence={target.entry!.evidence} criteria={target.item.criteria} /></details>) : <p>No judgments yet.</p>}</div> : <Notice>Requested run is not available in this comparison.</Notice> : <>
          <p className="field-hint">Clear is not an adoption decision. Missing evidence is not a pass.</p>
          {displayed.cases.map(item => <details className="eval-case" key={item.caseId} open={displayed.cases.length === 1 ? true : undefined}><summary><strong>{item.name}</strong><span>{exposureLabel[item.exposure]} · Baseline: {gate(item, "baseline")} · Candidate: {gate(item, "candidate")}</span></summary>
            <div className="eval-pair">{variants.map(variant => <RunSummary key={variant} item={item} variant={variant} agentId={agent.id} comparisonId={comparisonId} />)}</div>
            {item.criteria.map(criterion => <section className="eval-criterion" key={criterion.criterionId}><h3>{criterion.description} {criterion.criticalFailure ? <span className="revision-badge">Critical</span> : null}</h3><div className="eval-pair">{variants.map(variant => {
              const entry = item.runs[variant];
              const row = entry?.latestResult?.criteria.find(value => value.criterionId === criterion.criterionId);
              return <div key={variant}><h4>{words(variant)}</h4><strong>{words(row?.verdict ?? "not_evaluated")}</strong>{variant === "candidate" && item.regressions.includes(criterion.criterionId) ? <span> · Regression</span> : null}<p>{row?.reason ?? "No committed judgment for this criterion."}</p>{row ? <p className="field-hint">{row.grader.identity} · {row.grader.method} · {row.grader.version}</p> : null}<Evidence items={entry?.evidence.filter(value => row?.evidenceReferences.includes(value.ref)) ?? []} /></div>;
            })}</div></section>)}
          </details>)}
        </>}
      </> : !loading ? <Button variant="secondary" onClick={() => setRefresh(value => value + 1)}>Retry loading</Button> : null}
    </> : <><h2>Results</h2><p>Open a saved comparison, or create a new experiment. Authored profiles are not executed evaluations.</p><form onSubmit={event => { event.preventDefault(); if (openId.trim()) setParams(new URLSearchParams({ section: "agents", agent: agent.id, eval: "compare", comparison: openId.trim() })); }}><Field label="Comparison ID">{props => <Input {...props} required value={openId} onChange={event => setOpenId(event.target.value)} />}</Field><Button type="submit" variant="secondary">Open comparison</Button></form></>}
  </section>;
}

function RunSummary({ item, variant, agentId, comparisonId }: { item: EvaluationComparisonCaseView; variant: EvaluationVariantKind; agentId: string; comparisonId: string }) {
  const entry = item.runs[variant];
  if (!entry) return <div><h3>{words(variant)}</h3><p>Missing run · Incomplete</p></div>;
  const { run, latestResult } = entry;
  return <div><h3>{words(variant)}</h3><p>Execution: {words(run.status)}</p>{run.status === "completed" ? <p className="field-hint">{run.output === "no_public_reply" ? "No public reply" : run.output === "public_reply" ? "Public reply recorded" : "Output evidence unavailable"}</p> : null}{run.error ? <Notice>{run.error}</Notice> : null}<p>Grading: {latestResult ? words(latestResult.gradingStatus) : "Not evaluated"}</p>{latestResult?.errors.map((error, i) => <p key={i}>{error}</p>)}
    {run.attempt.roomId ? <Link to={`/?chat=${encodeURIComponent(run.attempt.roomId)}`}>Open eval chat{["pending", "running"].includes(run.status) ? " for Stop" : ""}</Link> : <p className="field-hint">Eval chat not admitted yet.</p>}
    <nav className="evaluation-section-links">{["completed", "failed", "cancelled"].includes(run.status) ? <Link to={evaluationUrl(agentId, "judge", { comparison: comparisonId, run: run.id })}>Add human judgment</Link> : null}<Link to={evaluationUrl(agentId, "history", { comparison: comparisonId, run: run.id })}>Judgment history</Link></nav>
    <Evidence items={entry.evidence} />
    <p className="field-hint">Elapsed: {latestResult?.agentUsage.elapsedSeconds == null ? "Unavailable" : `${latestResult.agentUsage.elapsedSeconds}s`} · Agent cost: {latestResult?.agentUsage.costUsd == null ? "Unavailable" : `$${latestResult.agentUsage.costUsd}`} · Evaluator cost: {latestResult?.evaluatorUsage.costUsd == null ? "Unavailable" : `$${latestResult.evaluatorUsage.costUsd}`}</p>
    <details><summary>Coverage limitations</summary>{run.coverageLimitations.length ? <ul>{run.coverageLimitations.map((text, i) => <li key={i}>{text}</li>)}</ul> : <p>No limitations recorded. This does not establish exhaustive coverage.</p>}</details>
  </div>;
}
function ResultRows({ result, evidence, criteria }: { result: EvaluationResult; evidence: EvaluationEvidenceView[]; criteria: EvaluationComparisonCaseView["criteria"] }) {
  return <>{result.errors.map((error, i) => <p key={i}>{error}</p>)}{result.criteria.map(row => <div key={row.criterionId}><strong>{criteria.find(item => item.criterionId === row.criterionId)?.description ?? row.criterionId} · {words(row.verdict)}</strong><p>{row.reason}</p><p>{row.grader.identity} · {row.grader.method}</p><Evidence items={evidence.filter(item => row.evidenceReferences.includes(item.ref))} /></div>)}</>;
}
type JudgmentDraft = { rows: AppendEvaluationResultInput["criteria"]; receipt: { fingerprint: string; operationId: string } | null };
function Judgment({ item, entry, root, drafts, onSaved }: { item: EvaluationComparisonCaseView; entry: NonNullable<EvaluationComparisonCaseView["runs"]["baseline"]>; root: string; drafts: Record<string, JudgmentDraft>; onSaved: () => void }) {
  const { api } = useSession();
  const draft = drafts[entry.run.id] ??= { rows: item.criteria.map(criterion => ({ criterionId: criterion.criterionId, verdict: "not_evaluated", reason: "", evidenceReferences: [] })), receipt: null };
  const [rows, setRows] = useState(draft.rows);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null), [saved, setSaved] = useState(false);
  const terminal = ["completed", "failed", "cancelled"].includes(entry.run.status);
  async function save() {
    if (busy || !terminal) return;
    if (rows.some(row => !row.reason.trim() || (["pass", "fail"].includes(row.verdict) && !row.evidenceReferences.length))) { setError("Every verdict needs a rationale. Pass and fail require authorized evidence."); return; }
    const fingerprint = JSON.stringify(rows);
    if (draft.receipt?.fingerprint !== fingerprint) draft.receipt = { fingerprint, operationId: crypto.randomUUID() };
    setBusy(true); setError(null); setSaved(false);
    try { await api(`${root}/runs/${encodeURIComponent(entry.run.id)}/results`, { criteria: rows, operationId: draft.receipt.operationId } satisfies AppendEvaluationResultInput); setSaved(true); onSaved(); }
    catch (err) { setError(errorMessage(err)); } finally { setBusy(false); }
  }
  return <form onSubmit={event => { event.preventDefault(); void save(); }}><h3>{item.name} · {words(entry.run.variant.kind)}</h3><p>Human reviewer identity is recorded from your authenticated account. Saving appends a new judgment.</p>{error ? <Notice>{error}</Notice> : null}{saved ? <Notice tone="success">Judgment appended.</Notice> : null}
    {!terminal ? <Notice>This run is not terminal; grading is unavailable.</Notice> : null}
    <fieldset disabled={busy || !terminal}>{item.criteria.map((criterion, index) => {
      const row = rows[index];
      function update(patch: Partial<typeof row>) { setSaved(false); setRows(current => { const next = current.map((value, i) => i === index ? { ...value, ...patch } : value); draft.rows = next; return next; }); }
      return <section key={criterion.criterionId} className="eval-criterion"><h3>{criterion.description}{criterion.criticalFailure ? " · Critical" : ""}</h3><Field label="Verdict">{props => <Select {...props} value={row.verdict} onChange={event => update({ verdict: event.target.value as EvaluationVerdict })}>{(["not_evaluated", "pass", "fail", "insufficient", "not_applicable"] as const).map(value => <option key={value} value={value}>{words(value)}</option>)}</Select>}</Field><Field label="Rationale">{props => <textarea {...props} required rows={3} value={row.reason} onChange={event => update({ reason: event.target.value })} />}</Field><fieldset><legend>Authorized evidence</legend>{entry.evidence.length ? entry.evidence.map(value => <div key={value.ref}><label><input type="checkbox" disabled={!value.available} checked={row.evidenceReferences.includes(value.ref)} onChange={event => update({ evidenceReferences: event.target.checked ? [...row.evidenceReferences, value.ref] : row.evidenceReferences.filter(ref => ref !== value.ref) })} /> {value.label}{!value.available ? " · Unavailable" : ""}{value.truncated ? " · Truncated" : ""}</label>{value.available && value.url ? <a href={value.url} target="_blank" rel="noreferrer">Open evidence in new tab</a> : null}</div>) : <p>No authorized evidence recorded.</p>}</fieldset></section>;
    })}</fieldset><Button type="submit" disabled={busy || !terminal}>{busy ? "Saving…" : "Save judgment"}</Button>
  </form>;
}
