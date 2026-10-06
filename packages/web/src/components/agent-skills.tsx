import { useEffect, useState, type ReactNode } from "react";
import type { SaveSkillInput, SkillDefinition, SkillSelection } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Modal, Notice, Spinner } from "./ui";
import { Markdown } from "./markdown";
import { MarkdownComposer } from "./markdown-composer";

export type SkillEditing = {
  input: SaveSkillInput;
  busy: boolean;
  error?: string;
  conflict?: boolean;
};

function PinnedSkill({ selection, children }: { selection: SkillSelection; children?: ReactNode }) {
  const { api } = useSession();
  const [skill, setSkill] = useState<SkillDefinition | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ skill: SkillDefinition }>(`/api/skills/${encodeURIComponent(selection.id)}/revisions/${selection.revision}`, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setSkill(result.skill); setError(""); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, selection.id, selection.revision, attempt]);
  return <article className="connection-card">
    {error ? <Notice>{error} <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Retry</Button></Notice> : null}
    {skill ? <><h3>{skill.name} · Revision {selection.revision}</h3><p>{skill.description}</p><details><summary>View instructions</summary><Markdown>{skill.instructions}</Markdown></details></> : <p>{error ? `Skill ${selection.id} · Revision ${selection.revision}` : <Spinner label="Loading skill" />}</p>}
    {children}
  </article>;
}

export function AgentSkillsPanel({ selections }: { selections: SkillSelection[] }) {
  return <section className="agent-connections"><h2>Skills</h2>
    {!selections.length ? <p>No skills assigned.</p> : selections.map(selection => <PinnedSkill key={`${selection.id}:${selection.revision}`} selection={selection} />)}
  </section>;
}

export function AgentSkillsEditor({ selections, onChange, busy, editing, onEditingChange }: {
  selections: SkillSelection[];
  onChange: (selections: SkillSelection[]) => void;
  busy: boolean;
  editing: SkillEditing | null;
  onEditingChange: (editing: SkillEditing | null) => void;
}) {
  const { api } = useSession();
  const [skills, setSkills] = useState<SkillDefinition[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ skills: SkillDefinition[] }>("/api/skills", undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setSkills(result.skills); setError(""); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, attempt]);

  function begin(skill?: SkillDefinition) {
    setNotice("");
    onEditingChange({ busy: false, input: {
      requestId: crypto.randomUUID(), name: skill?.name ?? "", description: skill?.description ?? "", instructions: skill?.instructions ?? "",
      ...(skill ? { id: skill.id, expectedRevision: skill.revision } : {}),
    } });
  }
  function update(key: "name" | "description" | "instructions", value: string) {
    if (!editing) return;
    onEditingChange({ ...editing, error: undefined, input: { ...editing.input, [key]: value, requestId: crypto.randomUUID() } });
  }
  function close() {
    if (!editing || editing.busy) return;
    if (window.confirm("Discard this unsaved skill edit?")) onEditingChange(null);
  }
  async function save() {
    if (!editing || editing.busy) return;
    onEditingChange({ ...editing, busy: true, error: undefined });
    try {
      const { skill } = await api<{ skill: SkillDefinition }>("/api/skills", editing.input);
      setSkills(current => [...(current ?? []).filter(item => item.id !== skill.id), skill]);
      onEditingChange(null);
      setNotice(`Saved ${skill.name}, revision ${skill.revision}. Assign or upgrade it explicitly, then save the agent to apply.`);
    } catch (error) {
      onEditingChange({ ...editing, busy: false, error: errorMessage(error), conflict: error instanceof ApiError && error.status === 409 });
    }
  }
  const disabled = busy || Boolean(editing);
  const invalid = editing && (!editing.input.name.trim() || !editing.input.description.trim() || !editing.input.instructions.trim() || editing.input.instructions.length > 50000);
  return <section className="agent-connections">
    <h2>Skills</h2>
    <p className="field-hint">Only explicitly assigned skills are available. Changes apply to new instances after saving this agent.</p>
    {notice ? <Notice tone="success">{notice}</Notice> : null}
    {error ? <Notice>{error} <Button variant="ghost" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>Retry library</Button></Notice> : null}
    {!skills && !error ? <Spinner label="Loading skills" /> : null}
    {!selections.length ? <p>No skills assigned.</p> : selections.map(selection => {
      const latest = skills?.find(skill => skill.id === selection.id);
      return <PinnedSkill key={`${selection.id}:${selection.revision}`} selection={selection}>
        <div className="button-row">
          <Button variant="secondary" disabled={disabled} onClick={() => onChange(selections.filter(item => item.id !== selection.id))}>Remove assignment</Button>
          {latest && latest.revision > selection.revision ? <Button variant="secondary" disabled={disabled || Boolean(error)} onClick={() => onChange(selections.map(item => item.id === selection.id ? { id: latest.id, revision: latest.revision } : item))}>Upgrade to revision {latest.revision}</Button> : null}
        </div>
      </PinnedSkill>;
    })}
    <details>
      <summary>Reusable skill library</summary>
      <p className="field-hint">Creating or editing a shared skill does not assign it or change existing assignments.</p>
      <div className="button-row"><Button variant="secondary" disabled={disabled} onClick={() => begin()}>Create skill</Button><Button variant="ghost" disabled={disabled} onClick={() => setAttempt(value => value + 1)}>Refresh library</Button></div>
      {skills?.length === 0 ? <p>No reusable skills yet.</p> : null}
      {skills?.map(skill => <article className="connection-card" key={skill.id}>
        <h3>{skill.name} · Revision {skill.revision}</h3><p>{skill.description}</p>
        <details><summary>View latest instructions</summary><Markdown>{skill.instructions}</Markdown></details>
        <div className="button-row">
          <Button variant="secondary" disabled={disabled || Boolean(error) || selections.length >= 50 || selections.some(item => item.id === skill.id)} onClick={() => onChange([...selections, { id: skill.id, revision: skill.revision }])}>{selections.some(item => item.id === skill.id) ? "Assigned" : "Assign skill"}</Button>
          <Button variant="ghost" disabled={disabled || Boolean(error)} onClick={() => begin(skill)}>Edit shared skill</Button>
        </div>
      </article>)}
      {selections.length >= 50 ? <p className="field-hint">The maximum of 50 skills is assigned.</p> : null}
    </details>
    {editing ? <Modal title={editing.input.id ? "Edit shared skill" : "Create shared skill"} description="Saving creates an immutable revision in the company library. Assignments stay unchanged." open onOpenChange={open => { if (!open) close(); }}>
      <div className="connection-dialog-form">
        {editing.error ? <Notice>{editing.error}{editing.conflict ? " Your text is preserved. Copy it before discarding, then refresh the library and reopen the latest revision." : " Retry with the same text to safely repeat this save."}</Notice> : null}
        <Field label="Name">{props => <Input {...props} autoFocus value={editing.input.name} maxLength={100} disabled={editing.busy} onChange={event => update("name", event.target.value)} />}</Field>
        <Field label="Description" hint="Tell the agent when this skill is useful.">{props => <Input {...props} value={editing.input.description} maxLength={500} disabled={editing.busy} onChange={event => update("description", event.target.value)} />}</Field>
        <Field label="Instructions" hint="Markdown instructions; maximum 50,000 characters." error={editing.input.instructions.length > 50000 ? "Shorten instructions to 50,000 characters or fewer." : undefined}>{props => <div className="composer agent-instructions-editor"><MarkdownComposer {...props} mode="document" label="Skill instructions" value={editing.input.instructions} disabled={editing.busy} readOnly={false} onChange={value => update("instructions", value)} placeholder="Describe the procedure and constraints." /></div>}</Field>
        <div className="button-row"><Button variant="secondary" disabled={editing.busy} onClick={close}>Discard skill edit</Button><Button disabled={editing.busy || Boolean(invalid) || editing.conflict} onClick={() => void save()}>{editing.busy ? <Spinner label="Saving skill" /> : null}Save skill revision</Button></div>
      </div>
    </Modal> : null}
  </section>;
}
