import type { EvaluationProfileDraft, EvaluationCase } from "../shared/evaluations";
import { Button, Field, Input, Select } from "./ui";

export function EvaluationFields({ draft, onChange, disabled = false }: {
  draft: EvaluationProfileDraft;
  onChange: (draft: EvaluationProfileDraft) => void;
  disabled?: boolean;
}) {
  function text(label: string, value: string, change: (value: string) => void, maxLength = 10000, required = false) {
    return <Field label={label}>{props => <textarea {...props} value={value} required={required} maxLength={maxLength} rows={3} onChange={event => change(event.target.value)} />}</Field>;
  }
  function updateCase(id: string, patch: Partial<EvaluationCase>) {
    onChange({ ...draft, cases: draft.cases.map(item => item.id === id ? { ...item, ...patch } : item) });
  }
  return <fieldset className="evaluation-fields" disabled={disabled}>
    {text("Responsibilities", draft.responsibilities, responsibilities => onChange({ ...draft, responsibilities }), 10000, true)}
    {text("Expected behavior", draft.expectedBehavior, expectedBehavior => onChange({ ...draft, expectedBehavior }), 10000, true)}
    {text("Prohibited actions", draft.prohibitedActions, prohibitedActions => onChange({ ...draft, prohibitedActions }))}
    <section className="evaluation-group">
      <h3>Criteria</h3>
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
    <section className="evaluation-group">
      <h3>Standalone cases</h3>
      {draft.cases.map((item, index) => <fieldset className="evaluation-item" key={item.id}>
        <legend>Case {index + 1}</legend>
        <Field label="Name">{props => <Input {...props} required maxLength={200} value={item.name} onChange={event => updateCase(item.id, { name: event.target.value })} />}</Field>
        <label className="evaluation-check"><input type="checkbox" checked={item.enabled} onChange={event => updateCase(item.id, { enabled: event.target.checked })} />Enabled</label>
        {text("Prompt", item.prompt, prompt => updateCase(item.id, { prompt }), 20000, true)}
        {text("Starting conditions", item.startingConditions, startingConditions => updateCase(item.id, { startingConditions }), 20000)}
        <fieldset className="evaluation-item"><legend>Input artifact references</legend>
          {item.inputArtifacts.map((artifact, artifactIndex) => <div className="evaluation-artifact" key={artifactIndex}>
            {(["name", "reference", "sha256"] as const).map(key => <Field key={key} label={key === "sha256" ? "SHA-256" : key === "name" ? "Artifact name" : "Reference"}>{props => <Input {...props} value={artifact[key]} onChange={event => updateCase(item.id, { inputArtifacts: item.inputArtifacts.map((value, position) => position === artifactIndex ? { ...value, [key]: event.target.value } : value) })} />}</Field>)}
            <Button variant="ghost" onClick={() => updateCase(item.id, { inputArtifacts: item.inputArtifacts.filter((_, position) => position !== artifactIndex) })}>Remove artifact {artifactIndex + 1}</Button>
          </div>)}
          <Button variant="secondary" disabled={item.inputArtifacts.length >= 20} onClick={() => updateCase(item.id, { inputArtifacts: [...item.inputArtifacts, { name: "", reference: "", sha256: "" }] })}>Add artifact reference</Button>
        </fieldset>
        <fieldset className="evaluation-criteria"><legend>Applicable criteria</legend>
          {!draft.criteria.length ? <p className="field-hint">Add criteria above.</p> : draft.criteria.map((criterion, criterionIndex) => <label className="evaluation-check" key={criterion.id}><input type="checkbox" checked={item.criterionIds.includes(criterion.id)} onChange={event => updateCase(item.id, { criterionIds: event.target.checked ? [...item.criterionIds, criterion.id] : item.criterionIds.filter(id => id !== criterion.id) })} />{criterion.description || `Criterion ${criterionIndex + 1}`}</label>)}
        </fieldset>
        {text("Expected outcome", item.expectedOutcome, expectedOutcome => updateCase(item.id, { expectedOutcome }), 20000, true)}
        <details className="evaluation-private"><summary>Evaluator-only material</summary>
          {text("Grading guidance", item.gradingGuidance, gradingGuidance => updateCase(item.id, { gradingGuidance }))}
          {text("Reference answer", item.evaluatorOnly.referenceAnswer, referenceAnswer => updateCase(item.id, { evaluatorOnly: { ...item.evaluatorOnly, referenceAnswer } }), 20000)}
          {text("Checks", item.evaluatorOnly.checks, checks => updateCase(item.id, { evaluatorOnly: { ...item.evaluatorOnly, checks } }), 20000)}
        </details>
        <Button variant="ghost" onClick={() => onChange({ ...draft, cases: draft.cases.filter(candidate => candidate.id !== item.id) })}>Remove case {index + 1}</Button>
      </fieldset>)}
      <Button variant="secondary" disabled={draft.cases.length >= 100} onClick={() => onChange({ ...draft, cases: [...draft.cases, { id: crypto.randomUUID(), name: "", enabled: true, prompt: "", startingConditions: "", inputArtifacts: [], expectedOutcome: "", criterionIds: [], gradingGuidance: "", evaluatorOnly: { referenceAnswer: "", checks: "" } }] })}>Add case</Button>
    </section>
  </fieldset>;
}
