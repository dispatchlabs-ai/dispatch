import { useRef } from "react";
import { Plus, FileText, ListChecks, Target } from "lucide-react";
import type { EvaluationProfileDraft, EvaluationCase } from "../shared/evaluations";
import { Button, Field, Input, Select } from "./ui";

export type EvaluationSection = "Expectations" | "Grading criteria" | "Cases";
export function EvaluationFields({ draft, onChange, disabled = false, section, onSectionChange, selectedCase, onCaseChange }: {
  section: EvaluationSection;
  onSectionChange: (section: EvaluationSection) => void;
  selectedCase: string | null;
  onCaseChange: (id: string | null) => void;
  draft: EvaluationProfileDraft;
  onChange: (draft: EvaluationProfileDraft) => void;
  disabled?: boolean;
}) {
  const newCaseId = useRef<string | null>(null);
  const activeCase = draft.cases.some(item => item.id === selectedCase) ? selectedCase : draft.cases[0]?.id;
  function addCase() {
    const id = crypto.randomUUID();
    newCaseId.current = id;
    onCaseChange(id); onSectionChange("Cases");
    onChange({ ...draft, cases: [...draft.cases, { id, name: "", enabled: true, split: "tuning", prompt: "", startingConditions: "", inputArtifacts: [], expectedOutcome: "", criterionIds: [], gradingGuidance: "", evaluatorOnly: { referenceAnswer: "", checks: "" } }] });
  }
  function text(label: string, value: string, change: (value: string) => void, maxLength = 10000, required = false) {
    return <Field label={label}>{props => <textarea {...props} value={value} required={required} maxLength={maxLength} rows={3} ref={node => { if (node) { node.style.height = "auto"; node.style.height = `${Math.min(node.scrollHeight, 360)}px`; } }} onChange={event => change(event.target.value)} />}</Field>;
  }
  function updateCase(id: string, patch: Partial<EvaluationCase>) {
    onChange({ ...draft, cases: draft.cases.map(item => item.id === id ? { ...item, ...patch } : item) });
  }
  return <div className="evaluation-authoring">
    <nav className="evaluation-outline" aria-label="Evaluation sections">
      <h3>Evaluation configuration</h3><p className="field-hint">{draft.criteria.length} {draft.criteria.length === 1 ? "criterion" : "criteria"} · {draft.cases.length} {draft.cases.length === 1 ? "case" : "cases"}</p>
      {([ ["Expectations", Target], ["Grading criteria", ListChecks], ["Cases", FileText] ] as const).map(([name, Icon]) => <Button key={name} variant="ghost" aria-current={section === name ? "location" : undefined} onClick={() => onSectionChange(name)}><Icon size={18} aria-hidden="true" />{name}</Button>)}
      <div className="evaluation-case-links">{draft.cases.map((item, index) => <Button key={item.id} variant="ghost" aria-current={section === "Cases" && item.id === activeCase ? "location" : undefined} onClick={() => { onCaseChange(item.id); onSectionChange("Cases"); }}>{item.name || `New case ${index + 1}`}</Button>)}</div>
      <Button variant="ghost" disabled={disabled || draft.cases.length >= 100} onClick={addCase}><Plus size={18} />Add case</Button>
    </nav>
    <fieldset className="evaluation-fields" disabled={disabled}>
    <section className="evaluation-group" data-evaluation-section="Expectations" hidden={section !== "Expectations"}><h3 tabIndex={-1}>Expectations</h3>
    {text("Responsibilities", draft.responsibilities, responsibilities => onChange({ ...draft, responsibilities }), 10000, true)}
    {text("Expected behavior", draft.expectedBehavior, expectedBehavior => onChange({ ...draft, expectedBehavior }), 10000, true)}
    {text("Prohibited actions", draft.prohibitedActions, prohibitedActions => onChange({ ...draft, prohibitedActions }))}
    </section>
    <section className="evaluation-group" data-evaluation-section="Grading criteria" hidden={section !== "Grading criteria"}>
      <h3 tabIndex={-1}>Grading criteria</h3>
      <p className="field-hint">Standards for judging work. Example: preserves unrelated changes.</p>
      {draft.criteria.map((criterion, index) => <fieldset className="evaluation-item" key={criterion.id}>
        <legend>Criterion {index + 1}</legend>
        {text("Description", criterion.description, description => onChange({ ...draft, criteria: draft.criteria.map(item => item.id === criterion.id ? { ...item, description } : item) }), 2000, true)}
        <Field label="Grading method">{props => <Select {...props} value={criterion.gradingMethod} onChange={event => onChange({ ...draft, criteria: draft.criteria.map(item => item.id === criterion.id ? { ...item, gradingMethod: event.target.value as typeof criterion.gradingMethod } : item) })}>
          <option value="direct">Direct check</option><option value="judge">Judge</option><option value="human">Human review</option>
        </Select>}</Field>
        {text("Grading guidance", criterion.gradingGuidance, gradingGuidance => onChange({ ...draft, criteria: draft.criteria.map(item => item.id === criterion.id ? { ...item, gradingGuidance } : item) }))}
        <label className="evaluation-check"><input type="checkbox" checked={criterion.criticalFailure} onChange={event => onChange({ ...draft, criteria: draft.criteria.map(item => item.id === criterion.id ? { ...item, criticalFailure: event.target.checked } : item) })} />Failure is critical</label>
        <Button variant="ghost" onClick={() => onChange({ ...draft, criteria: draft.criteria.filter(item => item.id !== criterion.id), cases: draft.cases.map(item => ({ ...item, criterionIds: item.criterionIds.filter(id => id !== criterion.id) })) })}>Remove criterion {index + 1}</Button>
      </fieldset>)}
      <Button variant="secondary" disabled={draft.criteria.length >= 100} onClick={() => onChange({ ...draft, criteria: [...draft.criteria, { id: crypto.randomUUID(), description: "", gradingMethod: "judge", criticalFailure: false, gradingGuidance: "" }] })}>Add criterion</Button>
    </section>
    <section className="evaluation-group" data-evaluation-section="Cases" hidden={section !== "Cases"}>
      <h3 tabIndex={-1}>Cases</h3>
      <p className="field-hint">Tasks for the agent, each with an expected outcome.</p>
      {!draft.cases.length ? <p className="field-hint">No cases yet. Add a task to define success.</p> : null}
      {draft.cases.map((item, index) => <div className="evaluation-case" data-case-id={item.id} hidden={item.id !== activeCase} key={item.id} ref={node => { if (node && newCaseId.current === item.id) { node.querySelector<HTMLInputElement>("input")?.focus(); newCaseId.current = null; } }}>
        <h3>{item.name || `New case ${index + 1}`}</h3>
        <fieldset className="evaluation-item" aria-label={`Case ${index + 1}`}>
        <Field label="Name">{props => <Input {...props} required maxLength={200} value={item.name} onChange={event => updateCase(item.id, { name: event.target.value })} />}</Field>
        <div className="evaluation-check-field"><label className="evaluation-check"><input type="checkbox" checked={item.enabled} onChange={event => updateCase(item.id, { enabled: event.target.checked })} />Enabled for future evaluations</label></div>
        {text("Task for the agent", item.prompt, prompt => updateCase(item.id, { prompt }), 20000, true)}
        <details className="evaluation-private"><summary>Starting conditions</summary>{text("Starting conditions", item.startingConditions, startingConditions => updateCase(item.id, { startingConditions }), 20000)}</details>
        <details className="evaluation-private"><summary>Input artifact references ({item.inputArtifacts.length})</summary><fieldset className="evaluation-item"><legend>Artifact details</legend>
          {item.inputArtifacts.map((artifact, artifactIndex) => <div className="evaluation-artifact" key={artifactIndex}>
            {(["name", "reference", "sha256"] as const).map(key => <Field key={key} label={key === "sha256" ? "SHA-256" : key === "name" ? "Artifact name" : "Reference"}>{props => <Input {...props} required maxLength={key === "sha256" ? 64 : key === "name" ? 200 : 2048} pattern={key === "sha256" ? "[0-9a-f]{64}" : ".*\\S.*"} title={key === "sha256" ? "64 lowercase hexadecimal characters" : "Enter a nonblank value"} value={artifact[key]} onChange={event => updateCase(item.id, { inputArtifacts: item.inputArtifacts.map((value, position) => position === artifactIndex ? { ...value, [key]: event.target.value } : value) })} />}</Field>)}
            <Button variant="ghost" onClick={() => updateCase(item.id, { inputArtifacts: item.inputArtifacts.filter((_, position) => position !== artifactIndex) })}>Remove artifact {artifactIndex + 1}</Button>
          </div>)}
          <Button variant="secondary" disabled={item.inputArtifacts.length >= 20} onClick={() => updateCase(item.id, { inputArtifacts: [...item.inputArtifacts, { name: "", reference: "", sha256: "" }] })}>Add artifact reference</Button>
        </fieldset></details>
        <fieldset className="evaluation-criteria"><legend>Applicable criteria</legend>
          {!draft.criteria.length ? <p className="field-hint">Add criteria above.</p> : draft.criteria.map((criterion, criterionIndex) => <label className="evaluation-check" key={criterion.id}><input type="checkbox" checked={item.criterionIds.includes(criterion.id)} onChange={event => updateCase(item.id, { criterionIds: event.target.checked ? [...item.criterionIds, criterion.id] : item.criterionIds.filter(id => id !== criterion.id) })} />{criterion.description || `Criterion ${criterionIndex + 1}`}</label>)}
        </fieldset>
        {text("Expected outcome", item.expectedOutcome, expectedOutcome => updateCase(item.id, { expectedOutcome }), 20000, true)}
        <details className="evaluation-private"><summary>Grading references and checks</summary>
          <p className="field-hint">Company-visible. Not included in agent instructions.</p>
          {text("Grading guidance", item.gradingGuidance, gradingGuidance => updateCase(item.id, { gradingGuidance }))}
          {text("Reference answer", item.evaluatorOnly.referenceAnswer, referenceAnswer => updateCase(item.id, { evaluatorOnly: { ...item.evaluatorOnly, referenceAnswer } }), 20000)}
          {text("Checks", item.evaluatorOnly.checks, checks => updateCase(item.id, { evaluatorOnly: { ...item.evaluatorOnly, checks } }), 20000)}
        </details>
        <Button variant="ghost" onClick={() => onChange({ ...draft, cases: draft.cases.filter(candidate => candidate.id !== item.id) })}>Remove case {index + 1}</Button>
      </fieldset></div>)}

    </section>
  </fieldset></div>;
}
