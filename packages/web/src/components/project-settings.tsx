import { Bot, Plus, Users } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentDefinition, CompanyPerson, Project, SaveProjectInput } from "../shared/contracts";
import { projectSourcesSchema } from "../shared/project-sources";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Notice, Select, Spinner } from "./ui";

export type ProjectEditing = {
  input: SaveProjectInput;
  busy: boolean;
  error?: string;
  conflict?: boolean;
  showValidation?: boolean;
};

export function beginProjectEdit(project: Project): ProjectEditing | null {
  if (!project.canManage || project.revision === undefined) return null;
  return { busy: false, input: {
    requestId: crypto.randomUUID(), expectedRevision: project.revision, name: project.name,
    members: project.members ?? [], defaultAgentDefinitionIds: project.defaultAgentDefinitionIds ?? [],
    repositories: project.repositories ?? [], spec: project.spec ?? null,
  } };
}

export function ProjectSettings({ project, agents, editing, onEditingChange, onSaved, showHeader = true }: {
  showHeader?: boolean;
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
    const controller = new AbortController();
    void api<{ people: CompanyPerson[] }>("/api/people", undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setPeople(result.people); setError(""); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, attempt]);

  const members = editing?.input.members ?? project.members ?? [];
  const defaults = editing?.input.defaultAgentDefinitionIds ?? project.defaultAgentDefinitionIds ?? [];
  const managerCount = members.filter(member => member.role === "manager").length;
  const disabled = Boolean(editing?.busy) || !project.canManage;
  const unavailableDefaults = defaults.filter(id => !agents.some(agent => agent.id === id && !agent.archived));
  const personName = (id: string) => people?.find(person => person.id === id)?.name ?? id;
  const agentName = (id: string) => agents.find(agent => agent.id === id)?.name ?? id;

  function update(patch: Partial<Pick<SaveProjectInput, "name" | "cwd" | "members" | "defaultAgentDefinitionIds" | "repositories" | "spec">>) {
    if (!editing || disabled) return;
    onEditingChange({ ...editing, error: undefined, input: { ...editing.input, ...patch, requestId: crypto.randomUUID() } });
  }
  const repositories = editing?.input.repositories ?? project.repositories ?? [];
  const spec = editing ? editing.input.spec : project.spec;
  const sources = { repositories, spec };
  const validation = editing?.showValidation ? projectSourcesSchema.safeParse(sources) : undefined;
  const fieldError = (path: string) => validation?.error?.issues.find(issue => issue.path.join(".") === path)?.message;
  const cwd = editing?.input.cwd === undefined ? project.cwd ?? "" : editing.input.cwd ?? "";
  const directorySpec = spec?.source === "directory";
  const missingRepository = spec?.source === "repository" && !repositories.some(repository => repository.id === spec.repositoryId);
  const missingDirectory = directorySpec && !cwd.trim();
  const directoryChanged = cwd.trim() !== (project.cwd ?? "");
  const directoryField = <Field label={directorySpec ? "Project directory" : "Working directory"} hint={directorySpec ? "Service-host directory · Also used by new local agents" : "Local service override · New instances only"} error={editing?.showValidation && missingDirectory ? "Set a project directory, or clear or reassign the spec first." : undefined}>{props => <>
    <Input {...props} value={cwd} disabled={disabled} maxLength={4096} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder={directorySpec ? "/path/to/project" : "Default workspace"} onChange={event => update({ cwd: event.target.value })} />
    {directorySpec && cwd.trim() ? <span className="project-directory-preview field-hint" aria-hidden="true">{cwd.trim()}</span> : null}
  </>}</Field>;

  function discard() {
    if (!editing?.busy && window.confirm("Discard unsaved project settings?")) onEditingChange(null);
  }
  async function save(form: HTMLFormElement) {
    if (!editing || disabled || editing.conflict || !editing.input.name.trim() || !managerCount || unavailableDefaults.length) return;
    if (!projectSourcesSchema.safeParse(sources).success || missingRepository || missingDirectory) {
      onEditingChange({ ...editing, showValidation: true });
      requestAnimationFrame(() => form.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    onEditingChange({ ...editing, busy: true, error: undefined });
    try {
      const result = await api<{ project: Project }>(`/api/projects/${encodeURIComponent(project.id)}`, editing.input);
      onEditingChange(null);
      onSaved(result.project);
    } catch (error) {
      onEditingChange({ ...editing, busy: false, error: errorMessage(error), conflict: error instanceof ApiError && error.status === 409 });
    }
  }

  return <section className={editing ? "project-editor" : "project-details"}>
    {editing ? <form className="project-editor-form" onSubmit={event => { event.preventDefault(); void save(event.currentTarget); }}>
      <div className="project-editor-scroll">
      <div className="project-editor-content stack">
      <header className="project-editor-heading"><p className="text-muted">{project.name}</p><h1 tabIndex={-1} id={`project-editor-${project.id}`}>Project settings</h1></header>
      {!project.canManage ? <Notice>Management permission removed. Draft retained.</Notice> : null}
      {editing.error ? <Notice>{editing.error}{editing.conflict ? " Draft retained. Discard to load current settings." : " Draft retained. Retry to save."}</Notice> : null}
      <Field label="Project name">{props => <Input {...props} value={editing.input.name} maxLength={100} required disabled={disabled} onChange={event => update({ name: event.target.value })} />}</Field>
      <fieldset className="agent-form-section project-repositories" disabled={disabled}>
        <legend>Repositories</legend>
        {repositories.map((repository, index) => <div className="project-repository" key={repository.id}>
          <div className="project-repository-fields">
            <Field label="Repository URL" error={fieldError(`repositories.${index}.url`)}>{props => <Input {...props} aria-label={`Repository ${index + 1} URL`} value={repository.url} required maxLength={4096} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="https://github.com/owner/repo" onBlur={() => {
              if (!repository.name.trim()) {
                try {
                  const name = new URL(repository.url).pathname.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "").slice(0, 100) ?? "";
                  if (name) update({ repositories: repositories.map(item => item.id === repository.id ? { ...item, name } : item) });
                } catch { /* The shared schema reports invalid URLs on save. */ }
              }
            }} onChange={event => update({ repositories: repositories.map(item => item.id === repository.id ? { ...item, url: event.target.value } : item) })} />}</Field>
            <Field label="Name" error={fieldError(`repositories.${index}.name`)}>{props => <Input {...props} aria-label={`Repository ${index + 1} name`} value={repository.name} required maxLength={100} onChange={event => update({ repositories: repositories.map(item => item.id === repository.id ? { ...item, name: event.target.value } : item) })} />}</Field>
          </div>
          <div className="project-repository-actions"><Button variant="ghost" disabled={spec?.source === "repository" && spec.repositoryId === repository.id} aria-label={`Remove repository ${repository.name || index + 1}`} onClick={() => update({ repositories: repositories.filter(item => item.id !== repository.id) })}>Remove</Button>
            {spec?.source === "repository" && spec.repositoryId === repository.id ? <span className="field-hint">Clear or reassign the spec first.</span> : null}
          </div>
        </div>)}
        <Button variant="secondary" onClick={() => update({ repositories: [...repositories, { id: crypto.randomUUID(), name: "", url: "" }] })}><Plus size={18} />Add repository</Button>
      </fieldset>
      <fieldset className="agent-form-section" disabled={disabled}>
        <legend tabIndex={-1} id={`project-spec-${project.id}`}>Spec file <span className="text-muted">(optional)</span></legend>
        <div className={`project-spec-fields${directorySpec ? " project-directory-spec" : ""}`}>
          <Field label="Source" error={missingRepository ? "Choose a source or clear the spec." : fieldError("spec.source") ?? fieldError("spec.repositoryId")}>{props => <Select {...props} value={spec?.source === "repository" ? `repository:${spec.repositoryId}` : spec?.source ?? ""} onChange={event => {
            const value = event.target.value;
            update({ spec: value === "directory" ? { source: "directory", path: spec?.path ?? "" } : value ? { source: "repository", repositoryId: value.slice("repository:".length), path: spec?.path ?? "" } : null });
          }}>
            <option value="">No spec file</option>
            <option value="directory">Project directory</option>
            {repositories.length ? <optgroup label="Repositories">{repositories.map((repository, index) => <option key={repository.id} value={`repository:${repository.id}`}>{repository.name.trim() || `Repository ${index + 1}`} — {repository.url.replace(/^https:\/\//i, "")}</option>)}</optgroup> : null}
          </Select>}</Field>
          {directorySpec ? directoryField : null}
          {spec ? <Field label={directorySpec ? "Path in project directory" : "Path in repository"} hint={directorySpec ? undefined : "From repository root"} error={fieldError("spec.path")}>{props => <Input {...props} value={spec.path} required maxLength={4096} autoComplete="off" autoCapitalize="none" spellCheck={false} placeholder="docs/spec.md" onChange={event => update({ spec: { ...spec, path: event.target.value } })} />}</Field> : null}
        </div>
        {directorySpec && directoryChanged ? <p className="field-hint" role="status">Spec base changed · Existing agents unchanged</p> : null}
        {spec ? <Button variant="ghost" onClick={() => update({ spec: null })}>Clear spec</Button> : null}
      </fieldset>
      {error ? <Notice>People could not be loaded. {error} <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Retry</Button></Notice> : null}
      {!people && !error ? <Spinner label="Loading people" /> : null}
      <fieldset className="agent-form-section" disabled={disabled}>
        <legend>Members</legend>
        <p className="field-hint">Full history access · Keep one manager</p>
        {members.map(member => <div className="connection-card" key={member.userId}>
          <Field label={`Role for ${personName(member.userId)}`}>{props => <Select {...props} value={member.role} disabled={member.role === "manager" && managerCount === 1} onChange={event => update({ members: members.map(item => item.userId === member.userId ? { ...item, role: event.target.value as "manager" | "member" } : item) })}>
            <option value="member">Member</option><option value="manager">Manager</option>
          </Select>}</Field>
          {member.role === "manager" && managerCount === 1 ? <p className="field-hint">Add another manager to change this role.</p> : null}
          <Button variant="secondary" disabled={member.role === "manager" && managerCount === 1} onClick={() => update({ members: members.filter(item => item.userId !== member.userId) })}>Remove {personName(member.userId)}</Button>
        </div>)}
        <Field label="Add member">{props => <Select {...props} value="" disabled={!people || Boolean(error)} onChange={event => { if (event.target.value) update({ members: [...members, { userId: event.target.value, role: "member" }] }); }}>
          <option value="">Choose a person</option>
          {people?.filter(person => !members.some(member => member.userId === person.id)).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </Select>}</Field>
      </fieldset>
      <fieldset className="agent-form-section" disabled={disabled}>
        <legend>Default agents</legend>
        <p className="field-hint">Defaults for new chats</p>
        {agents.filter(agent => !agent.archived).map(agent => <label className="choice-row" key={agent.id}>
          <input type="checkbox" checked={defaults.includes(agent.id)} onChange={event => update({ defaultAgentDefinitionIds: event.target.checked ? [...defaults, agent.id] : defaults.filter(id => id !== agent.id) })} />
          <span>{agent.name}<small>{agent.description}</small></span>
        </label>)}
        {unavailableDefaults.map(id => <div className="connection-card" key={id}><p>{agentName(id)} is unavailable. Remove it before saving.</p><Button variant="secondary" onClick={() => update({ defaultAgentDefinitionIds: defaults.filter(item => item !== id) })}>Remove unavailable default</Button></div>)}
      </fieldset>
      {!directorySpec ? <details className="project-advanced"><summary>Advanced</summary>{directoryField}</details> : null}
      </div></div>
      <footer className="project-editor-actions"><p className="project-editor-content field-hint">References only · No cloning or agent runs</p><div className="project-editor-content button-row"><Button variant="secondary" disabled={editing.busy} onClick={discard}>Discard</Button><Button type="submit" disabled={disabled || editing.conflict || !editing.input.name.trim() || !managerCount || Boolean(unavailableDefaults.length)}>{editing.busy ? <Spinner label="Saving project" /> : null}Save project</Button></div></footer>
    </form> : <>
      {showHeader ? <header className="context-header"><h2>Project details</h2></header> : null}
      <div className="project-details-body">
      <div className="project-sharing"><Users size={24} aria-hidden="true" /><div><strong>Shared project</strong><p>Full history · Shared chats</p></div></div>
      {error ? <Notice>People could not be loaded. {error} <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Retry</Button></Notice> : null}
      {!people && !error ? <Spinner label="Loading people" /> : null}
      <section className="project-detail-group"><h3>Members</h3>
      <ul>{members.map(member => <li key={member.userId}><span className="participant-avatar" aria-hidden="true">{personName(member.userId).split(/\s+/).slice(0, 2).map(part => part[0]).join("")}</span><span>{personName(member.userId)}<small>{member.role === "manager" ? "Manager" : "Member"}</small></span></li>)}</ul></section>
      <section className="project-detail-group"><h3>Default agents</h3>
      {defaults.length ? <ul>{defaults.map(id => <li key={id}><span className="project-chat-icon"><Bot size={22} aria-hidden="true" /></span><span>{agentName(id)}{unavailableDefaults.includes(id) ? <small>Unavailable</small> : null}</span></li>)}</ul> : <p className="text-muted">No default agents</p>}</section>
      {!project.canManage ? <p className="field-hint">Managed by project managers</p> : null}
      </div>
    </>}
  </section>;
}
