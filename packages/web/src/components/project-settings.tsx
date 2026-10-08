import { useEffect, useState } from "react";
import type { AgentDefinition, CompanyPerson, Project, SaveProjectInput } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Notice, Select, Spinner } from "./ui";

export type ProjectEditing = {
  input: SaveProjectInput;
  busy: boolean;
  error?: string;
  conflict?: boolean;
};

export function ProjectSettings({ project, agents, editing, onEditingChange, onSaved }: {
  project: Project;
  agents: AgentDefinition[];
  editing: ProjectEditing | null;
  onEditingChange: (editing: ProjectEditing | null) => void;
  onSaved: (project: Project) => void;
}) {
  const { api } = useSession();
  const [people, setPeople] = useState<CompanyPerson[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (project.kind !== "shared") return;
    const controller = new AbortController();
    void api<{ people: CompanyPerson[] }>("/api/people", undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setPeople(result.people); setError(""); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, project.kind, attempt]);

  if (project.kind !== "shared") return <p className="field-hint">Personal grouping. Chat invitations control access; this grouping does not share chats.</p>;

  const members = editing?.input.members ?? project.members ?? [];
  const defaults = editing?.input.defaultAgentDefinitionIds ?? project.defaultAgentDefinitionIds ?? [];
  const managerCount = members.filter(member => member.role === "manager").length;
  const disabled = Boolean(editing?.busy) || !project.canManage;
  const unavailableDefaults = defaults.filter(id => !agents.some(agent => agent.id === id && !agent.archived));
  const personName = (id: string) => people?.find(person => person.id === id)?.name ?? id;
  const agentName = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;

  function begin() {
    if (!project.canManage || project.revision === undefined) return;
    onEditingChange({ busy: false, input: {
      requestId: crypto.randomUUID(), expectedRevision: project.revision, name: project.name,
      members: project.members ?? [], defaultAgentDefinitionIds: project.defaultAgentDefinitionIds ?? [],
    } });
  }
  function update(patch: Partial<Pick<SaveProjectInput, "name" | "members" | "defaultAgentDefinitionIds">>) {
    if (!editing || disabled) return;
    onEditingChange({ ...editing, input: { ...editing.input, ...patch, requestId: crypto.randomUUID() } });
  }
  function discard() {
    if (!editing?.busy && window.confirm("Discard unsaved project settings?")) onEditingChange(null);
  }
  async function save() {
    if (!editing || disabled || editing.conflict || !editing.input.name.trim() || !managerCount || unavailableDefaults.length) return;
    onEditingChange({ ...editing, busy: true, error: undefined });
    try {
      const result = await api<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}`, editing.input);
      onEditingChange(null);
      onSaved(result.project);
    } catch (error) {
      onEditingChange({ ...editing, busy: false, error: errorMessage(error), conflict: error instanceof ApiError && error.status === 409 });
    }
  }

  return <section className="agent-connections">
    <h2>Project settings</h2>
    <p className="field-hint">Members can read the full project history and participate in its chats. Managers also control membership and default agents. Operator-designated readers can read all shared projects without membership.</p>
    {error ? <Notice>People could not be loaded. {error} <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Retry</Button></Notice> : null}
    {!people && !error ? <Spinner label="Loading people" /> : null}
    {editing ? <div className="stack">
      {!project.canManage ? <Notice>You no longer have permission to save these settings. Your draft is retained until you discard it.</Notice> : null}
      {editing.error ? <Notice>{editing.error}{editing.conflict ? " Your draft is preserved. Copy anything you need, then discard and reopen the latest settings." : " Retry unchanged to safely repeat this request."}</Notice> : null}
      <Field label="Project name">{props => <Input {...props} value={editing.input.name} maxLength={100} disabled={disabled} onChange={event => update({ name: event.target.value })} />}</Field>
      <fieldset className="agent-form-section" disabled={disabled}>
        <legend>Members</legend>
        <p className="field-hint">Saving additions grants access to all existing chats. Saving removals immediately revokes project membership, but cannot retract copies already seen or an operator-granted read-all permission. Keep at least one manager.</p>
        {members.map(member => <div className="connection-card" key={member.userId}>
          <Field label={`Role for ${personName(member.userId)}`}>{props => <Select {...props} value={member.role} disabled={member.role === "manager" && managerCount === 1} onChange={event => update({ members: members.map(item => item.userId === member.userId ? { ...item, role: event.target.value as "manager" | "member" } : item) })}>
            <option value="member">Member</option><option value="manager">Manager</option>
          </Select>}</Field>
          {member.role === "manager" && managerCount === 1 ? <p className="field-hint">Add another manager before demoting or removing this one.</p> : null}
          <Button variant="secondary" disabled={member.role === "manager" && managerCount === 1} onClick={() => update({ members: members.filter(item => item.userId !== member.userId) })}>Remove {personName(member.userId)}</Button>
        </div>)}
        <Field label="Add member">{props => <Select {...props} value="" disabled={!people || Boolean(error)} onChange={event => { if (event.target.value) update({ members: [...members, { userId: event.target.value, role: "member" }] }); }}>
          <option value="">Choose a person</option>
          {people?.filter(person => !members.some(member => member.userId === person.id)).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </Select>}</Field>
      </fieldset>
      <fieldset className="agent-form-section" disabled={disabled}>
        <legend>Default agents</legend>
        <p className="field-hint">Preselected for new chats only. Existing participants and their saved configurations stay unchanged.</p>
        {agents.filter(agent => !agent.archived).map(agent => <label className="choice-row" key={agent.id}>
          <input type="checkbox" checked={defaults.includes(agent.id)} onChange={event => update({ defaultAgentDefinitionIds: event.target.checked ? [...defaults, agent.id] : defaults.filter(id => id !== agent.id) })} />
          <span>{agent.name}<small>{agent.description}</small></span>
        </label>)}
        {unavailableDefaults.map(id => <div className="connection-card" key={id}><p>{agentName(id)} is unavailable. Remove it before saving.</p><Button variant="secondary" onClick={() => update({ defaultAgentDefinitionIds: defaults.filter(item => item !== id) })}>Remove unavailable default</Button></div>)}
      </fieldset>
      <div className="button-row"><Button variant="secondary" disabled={editing.busy} onClick={discard}>Discard settings</Button><Button disabled={disabled || editing.conflict || !editing.input.name.trim() || !managerCount || Boolean(unavailableDefaults.length)} onClick={() => void save()}>{editing.busy ? <Spinner label="Saving project" /> : null}Save project settings</Button></div>
    </div> : <>
      <h3>Members</h3>
      <ul>{members.map(member => <li key={member.userId}>{personName(member.userId)} · {member.role === "manager" ? "Manager" : "Member"}</li>)}</ul>
      <h3>Default agents</h3>
      {defaults.length ? <ul>{defaults.map(id => <li key={id}>{agentName(id)}{unavailableDefaults.includes(id) ? " · Unavailable" : ""}</li>)}</ul> : <p>No default agents selected.</p>}
      {project.canManage ? <Button variant="secondary" onClick={begin}>Edit project settings</Button> : <p className="field-hint">Only project managers can change these settings.</p>}
    </>}
  </section>;
}
