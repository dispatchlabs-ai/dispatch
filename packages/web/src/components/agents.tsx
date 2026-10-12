import { NamedSecrets } from "./named-secrets";
import { ArrowRight, Archive, Bot, Pencil } from "lucide-react";
import { useRef, useState } from "react";
import type {
  AgentDefinition,
  AgentDraft,
  ApplicationConfig,
  ExecutionBackend,
  SaveAgentInput,
  ThinkingLevel,
} from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { describeAgentTools } from "../lib/agent-tools";
import { useSession } from "../lib/session";
import { Button, Field, Input, Modal, Notice, Select, Spinner } from "./ui";
import { AgentSkillsEditor, AgentSkillsPanel, type SkillEditing } from "./agent-skills";
import { AgentConnectionsEditor, AgentConnectionsPanel } from "./agent-connections";
import { AgentEvaluation } from "./agent-evaluation";
import { Markdown } from "./markdown";
import { MarkdownComposer } from "./markdown-composer";

export type AgentEditing = {
  key: string;
  saved?: AgentDefinition;
  initialDraft: AgentDraft;
  draft: AgentDraft;
  skillEditing: SkillEditing | null;
  initialConnectionIds: string[];
  connectionIds: string[];
  applyConnectionsToExisting: boolean;
  busy: boolean;
};

export function beginAgentEdit(
  saved?: AgentDefinition,
  defaultAgent?: AgentDefinition,
): AgentEditing {
  const initialDraft: AgentDraft = {
    executionBackend: (saved ?? defaultAgent)?.executionBackend ?? "pi",
    name: saved?.name ?? "",
    description: saved?.description ?? "",
    instructions: saved?.instructions ?? "",
    provider: saved?.provider ?? defaultAgent?.provider ?? "",
    modelId: saved?.modelId ?? defaultAgent?.modelId ?? "",
    thinkingLevel: saved?.thinkingLevel ?? defaultAgent?.thinkingLevel ?? "off",
    capabilities: saved?.capabilities ?? [],
    skills: saved?.skills ?? [],
  };
  const connectionIds = saved?.connections?.filter(connection => connection.source === "managed" || connection.source === "oauth").map(connection => connection.id) ?? [];
  return {
    key: crypto.randomUUID(),
    saved,
    initialDraft,
    draft: initialDraft,
    skillEditing: null,
    initialConnectionIds: connectionIds,
    connectionIds,
    applyConnectionsToExisting: false,
    busy: false,
  };
}

export function agentEditIsDirty(editing: AgentEditing) {
  return JSON.stringify(editing.draft) !== JSON.stringify(editing.initialDraft)
    || agentConnectionsChanged(editing) || editing.skillEditing !== null;
}

function agentConnectionsChanged(editing: AgentEditing) {
  return JSON.stringify([...editing.connectionIds].sort()) !== JSON.stringify([...editing.initialConnectionIds].sort());
}

function runtimeLabel(backend: AgentDraft["executionBackend"]) {
  return backend === "muse-code" ? "Muse Code" : backend === "claude-agent-sdk" ? "Agent SDK" : "Pi";
}

function modelsForRuntime(config: ApplicationConfig, backend: AgentDraft["executionBackend"]) {
  return backend && backend !== "pi"
    ? (config.sdkModels ?? []).filter(model => model.provider === (backend === "muse-code" ? "muse-code" : "anthropic"))
    : config.models.filter(model => model.provider !== "muse-code");
}

function thinkingLabel(level: ThinkingLevel) {
  return level[0].toUpperCase() + level.slice(1);
}

export function AgentsPage({
  agent,
  editing,
  config,
  onEditingChange,
  onSaved,
  onCancel,
  onEdit,
  onStartChat,
  creating,
  onConnectionsSettings,
  onEvaluationGuardChange,
  evaluationAgent, onEvaluationAgentChange, onEvaluationContextChange,
}: {
  evaluationAgent: string | null;
  onEvaluationAgentChange: (id: string | null) => void;
  onEvaluationContextChange: (context: React.ReactNode) => void;
  onEvaluationGuardChange: (guard: { dirty: boolean; busy: boolean }) => void;
  agent?: AgentDefinition;
  editing: AgentEditing | null;
  config: ApplicationConfig;
  onEditingChange: (editing: AgentEditing) => void;
  onSaved: (agent: AgentDefinition) => void;
  onCancel: () => void;
  onEdit: (agent: AgentDefinition) => void;
  onStartChat: (agentId: string) => void;
  creating: boolean;
  onConnectionsSettings: () => void;
}) {
  const evaluationOpen = !!agent && evaluationAgent === agent.id;
  if (editing)
    return (
      <AgentEditor
        key={editing.key}
        editing={editing}
        config={config}
        onChange={onEditingChange}
        onCancel={onCancel}
        onSaved={onSaved}
        onConnectionsSettings={onConnectionsSettings}
      />
    );

  if (!agent)
    return (
      <section className="agent-view">
        <header className="view-heading">
          <div>
            <h1>Agents</h1>
            <p>Shared with your company</p>
          </div>
        </header>
        <div className="page-state">
          <p>Choose an agent from the sidebar, or create a new one.</p>
        </div>
      </section>
    );

  const isDefault = agent.id === config.defaultAgentId;
  const model = modelsForRuntime(config, agent.executionBackend).find(
    (model) => model.provider === agent.provider && model.id === agent.modelId,
  );
  return (
    <section className="agent-view">
      <header className="view-heading agent-heading">
        <div>
          <p className="page-eyebrow">Agents{evaluationOpen ? ` / ${agent.name}` : ""}</p>
          <div className="agent-title-line"><span className="agent-object-icon"><Bot size={30} aria-hidden="true" /></span><h1>{evaluationOpen ? "Evaluations" : agent.name}</h1>{isDefault && !evaluationOpen ? <span className="sidebar-tag">Default</span> : null}</div>
          <p>{agent.archived ? "Archived agent" : evaluationOpen ? "Define evaluations · Runs not available yet" : agent.description || "Shared with your company"}</p>
        </div>
        {!agent.archived && !evaluationOpen ? (
          <div className="button-row agent-actions">
            <Button variant="ghost" onClick={() => onEdit(agent)}>
              <Pencil /> Edit agent
            </Button>
            <Button
              className="agent-start-chat"
              disabled={creating}
              onClick={() => onStartChat(agent.id)}
            >
              {creating ? <Spinner /> : <ArrowRight />} Start chat
            </Button>
          </div>
        ) : null}
      </header>
      <nav className="object-section-nav" aria-label="Agent views">
        <Button variant="ghost" aria-current={!evaluationOpen ? "page" : undefined} onClick={() => onEvaluationAgentChange(null)}>Overview</Button>
        <Button variant="ghost" className="evaluation-entry" aria-current={evaluationOpen ? "page" : undefined} onClick={() => onEvaluationAgentChange(agent.id)}>Evaluations</Button>
      </nav>
      <div className={evaluationOpen ? "agent-content evaluation-workspace" : "agent-content"}>
        <div className="agent-content-inner">
          <div hidden={evaluationOpen}>
          <p className="agent-phone-facts">
            {agent.executionBackend && agent.executionBackend !== "pi" ? `${runtimeLabel(agent.executionBackend)} · ` : null}
            {model?.name || agent.modelId || "No model configured"} ·{" "}
            {thinkingLabel(agent.thinkingLevel)} thinking · {agent.tools.length || agent.skills?.length ? `${agent.tools.length + (agent.skills?.length ? 1 : 0)} tools` : "No tools"}
          </p>
          <section className="agent-instructions">
            <h2>Instructions</h2>
            <Markdown>
              {agent.instructions || "No additional instructions."}
            </Markdown>
          </section>
          <NamedSecrets key={`secrets-${agent.id}`} agentId={agent.id} disabled={agent.archived} />
          <AgentSkillsPanel selections={agent.skills ?? []} />
          <AgentConnectionsPanel key={agent.id} agentId={agent.id} />
          {agent.archived ? (
            <Notice tone="info">
              This agent is archived. Existing chats keep their saved
              configuration.
            </Notice>
          ) : null}
          </div>
          <div hidden={!evaluationOpen} className="evaluation-workspace-content">
            <AgentEvaluation active={evaluationOpen} key={`evaluation:${agent.id}`} agentId={agent.id} readOnly={agent.archived} onGuardChange={onEvaluationGuardChange} onContextChange={onEvaluationContextChange} onClose={() => { onEvaluationAgentChange(null); requestAnimationFrame(() => document.querySelector<HTMLElement>(".evaluation-entry")?.focus()); }} />
          </div>
        </div>
      </div>
    </section>
  );
}

export function AgentArchiveDialog({
  agent,
  onClose,
  onSaved,
  onRefresh,
}: {
  agent: AgentDefinition;
  onClose: () => void;
  onSaved: (agent: AgentDefinition) => void;
  onRefresh: () => Promise<void>;
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal
      title={`Archive ${agent.name}?`}
      description="This agent will no longer be available for new chats. Existing chats will keep their saved configuration."
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
      finalFocus={() => document.getElementById("main-workspace")}
    >
      {error ? <Notice>{error}</Notice> : null}
      <div className="button-row">
        <Button variant="secondary" disabled={busy} onClick={onClose}>
          Keep agent
        </Button>
        <Button
          variant="danger"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(null);
            void api<{ agent: AgentDefinition }>(
              `/api/agents/${encodeURIComponent(agent.id)}/archive`,
              { expectedRevision: agent.revision },
            )
              .then(({ agent }) => {
                onSaved(agent);
                onClose();
              })
              .catch((error) => {
                setError(errorMessage(error));
                if (error instanceof ApiError && error.status === 409)
                  void onRefresh();
              })
              .finally(() => setBusy(false));
          }}
        >
          {busy ? <Spinner /> : <Archive />} Archive agent
        </Button>
      </div>
    </Modal>
  );
}

function DraftFact({
  label,
  value,
  saved,
}: {
  label: string;
  value: string;
  saved?: string;
}) {
  const changed = saved !== undefined && saved !== value;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {changed ? (
          <>
            <span className="saved-fact">
              <span className="sr-only">Saved: </span>
              {saved || "Not set"}
            </span>
            <span className="draft-fact">
              <span className="draft-label">Draft</span> {value || "Not set"}
            </span>
          </>
        ) : (
          value || "Not set"
        )}
      </dd>
    </div>
  );
}

export function AgentDetails({
  agent,
  editing,
  config,
  showHeader = true,
}: {
  agent?: AgentDefinition;
  editing: AgentEditing | null;
  config: ApplicationConfig | null;
  showHeader?: boolean;
}) {
  const saved = editing ? editing.saved : agent;
  const current = editing?.draft ?? saved;
  const modelName = (provider: string, id: string, backend: AgentDraft["executionBackend"]) =>
    (config ? modelsForRuntime(config, backend) : []).find(
      (model) => model.provider === provider && model.id === id,
    )?.name || id;
  const contentChanged = editing?.saved
    ? (["name", "description", "instructions"] as const).filter(
        (key) => editing.draft[key] !== editing.saved![key],
      )
    : [];
  return (
    <div className={current ? "agent-details" : "context-empty"}>
      {showHeader ? <header className="context-header">
        <h2>{editing ? "Draft configuration" : "Configuration"}</h2>
      </header> : null}
      <div className="context-body">
        {current ? (
          <>
            <div className="context-title">
              <span className="revision-badge">
                {editing ? agentEditIsDirty(editing) ? "Unsaved changes" : "Draft" : `Revision ${saved!.revision}`}
              </span>
            </div>
            {editing ? (
              <p className="context-description">
                {saved
                  ? `Based on revision ${saved.revision}`
                  : "New agent draft"}
              </p>
            ) : null}
            <dl className="context-facts">
              {!editing ? (
                <div>
                  <dt>Status</dt>
                  <dd>{saved?.archived ? "Archived" : "Active"}</dd>
                </div>
              ) : null}
              <DraftFact
                label="Runtime"
                value={runtimeLabel(current.executionBackend)}
                saved={editing && saved ? runtimeLabel(saved.executionBackend) : undefined}
              />
              <DraftFact
                label="Model"
                value={modelName(current.provider, current.modelId, current.executionBackend)}
                saved={
                  editing && saved
                    ? modelName(saved.provider, saved.modelId, saved.executionBackend)
                    : undefined
                }
              />
              <DraftFact
                label="Provider"
                value={current.provider}
                saved={editing ? saved?.provider : undefined}
              />
              <DraftFact
                label="Thinking"
                value={thinkingLabel(current.thinkingLevel)}
                saved={
                  editing && saved
                    ? thinkingLabel(saved.thinkingLevel)
                    : undefined
                }
              />
              <DraftFact label="Skills" value={String(current.skills?.length ?? 0)} saved={editing && saved ? String(saved.skills?.length ?? 0) : undefined} />
              <div>
                <dt>Tools</dt>
                <dd>{editing ? `${describeCapabilities(editing.draft.capabilities)} · ${editing.connectionIds.length + (saved?.connections?.filter(connection => connection.source === "operator").length ?? 0)} connections` : describeAgentTools([...(saved?.tools ?? []), ...(saved?.skills?.length ? ["load_skill"] : [])])}</dd>
              </div>
            </dl>
            {contentChanged.length ? (
              <section className="draft-changes">
                <h3>Unsaved changes</h3>
                <ul>
                  {contentChanged.map((key) => (
                    <li key={key}>
                      {key[0].toUpperCase() + key.slice(1)} changed
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </>
        ) : (
          <p>No agent selected.</p>
        )}
      </div>
    </div>
  );
}

function AgentEditor({
  editing,
  config,
  onChange,
  onSaved,
  onCancel,
  onConnectionsSettings,
}: {
  editing: AgentEditing;
  config: ApplicationConfig;
  onChange: (editing: AgentEditing) => void;
  onSaved: (agent: AgentDefinition) => void;
  onCancel: () => void;
  onConnectionsSettings: () => void;
}) {
  const { api } = useSession();
  const { saved: agent, draft, busy } = editing;
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const formRef = useRef<HTMLFormElement>(null);
  const [section, setSection] = useState("Identity");
  function selectSection(name: string) {
    setSection(name);
    const target = formRef.current?.querySelector<HTMLElement>(`[data-agent-section="${name}"]`);
    if (target instanceof HTMLDetailsElement) target.open = true;
    // Keep section navigation inside the form instead of moving the page viewport.
    const scroll = target?.closest<HTMLElement>(".agent-editor-scroll");
    if (target && scroll) {
      scroll.scrollTo({ top: scroll.scrollTop + target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - parseFloat(getComputedStyle(target).scrollMarginTop) });
    }
    target?.focus({ preventScroll: true });
  }
  const saveRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const dirty = agentEditIsDirty(editing);
  const instructionsTooLong = draft.instructions.length > 50000;
  const backend = draft.executionBackend ?? "pi";
  const sdk = backend !== "pi";
  const models = modelsForRuntime(config, backend);
  const model = models.find(
    (model) => model.provider === draft.provider && model.id === draft.modelId,
  );
  const runtimeSelections = useRef<Partial<Record<ExecutionBackend, Pick<AgentDraft, "provider" | "modelId" | "thinkingLevel">>>>({});
  function changeRuntime(next: ExecutionBackend) {
    runtimeSelections.current[backend] = {
      provider: draft.provider, modelId: draft.modelId, thinkingLevel: draft.thinkingLevel,
    };
    const choices = modelsForRuntime(config, next);
    const prior = runtimeSelections.current[next];
    const selected = choices.find(value => value.provider === (prior ?? draft).provider && value.id === (prior ?? draft).modelId) ?? choices[0];
    const thinking = prior?.thinkingLevel ?? draft.thinkingLevel;
    onChange({
      ...editing,
      draft: {
        ...draft,
        executionBackend: next,
        provider: selected?.provider ?? (next === "muse-code" ? "muse-code" : next === "claude-agent-sdk" ? "anthropic" : ""),
        modelId: selected?.id ?? "",
        thinkingLevel: selected?.thinkingLevels.includes(thinking) ? thinking : selected?.thinkingLevels[0] ?? "off",
      },
    });
  }
  const modelKey = JSON.stringify([draft.provider, draft.modelId]);
  function update<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) {
    onChange({ ...editing, draft: { ...draft, [key]: value } });
  }

  return (
    <section className="agent-editor agent-view">
      <header className="view-heading agent-heading">
        <div>
          <p className="page-eyebrow">Agents / {agent?.name || "New agent"}</p>
          <h1>{agent ? "Edit agent" : "New agent"}</h1>
          <p>
            {agent
              ? `Based on revision ${agent.revision}`
              : "Shared with your company"}
          </p>
        </div>
        <span className="revision-badge">{dirty ? "Unsaved changes" : agent ? `Revision ${agent.revision}` : "Draft"}</span>
      </header>
      <nav className="object-section-nav" aria-label="Agent editor sections">{["Identity", "Instructions", "Model", "Capabilities", "Skills", "Connections"].map(name => <Button key={name} variant="ghost" aria-current={section === name ? "location" : undefined} onClick={() => selectSection(name)}>{name}</Button>)}</nav>
      <form ref={formRef}
        className="agent-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (instructionsTooLong || editing.skillEditing || (sdk && !model)) return;
          onChange({ ...editing, busy: true });
          setError(null);
          setConflict(false);
          const input: SaveAgentInput = {
            ...draft,
            connectionIds: editing.connectionIds,
            applyConnectionsToExisting: agentConnectionsChanged(editing) && editing.applyConnectionsToExisting,
            ...(agent
              ? { id: agent.id, expectedRevision: agent.revision }
              : {}),
          };
          const fingerprint = JSON.stringify(input);
          if (saveRequest.current?.fingerprint !== fingerprint) saveRequest.current = { fingerprint, requestId: crypto.randomUUID() };
          input.requestId = saveRequest.current.requestId;
          void api<{ agent: AgentDefinition }>("/api/agents", input)
            .then(({ agent }) => onSaved(agent))
            .catch((error) => {
              setError(errorMessage(error));
              setConflict(error instanceof ApiError && error.status === 409);
              onChange({ ...editing, busy: false });
            });
        }}
      >
        <div className="agent-editor-scroll">
          <div className="agent-form-sections">
            {error ? (
              <Notice>
                {error}
                {conflict
                  ? " Your changes are still here. Copy anything you want to keep, then discard and reopen the latest revision."
                  : ""}
              </Notice>
            ) : null}
            <fieldset disabled={busy} className="agent-form-section agent-identity-fields" data-agent-section="Identity" tabIndex={-1}>
              <legend className="sr-only">Identity</legend>
              <Field label="Name">
                {(props) => (
                  <Input
                    {...props}
                    autoFocus
                    value={draft.name}
                    onChange={(event) => update("name", event.target.value)}
                    required
                    maxLength={100}
                    placeholder="e.g. Research partner"
                  />
                )}
              </Field>
              <Field label="Description">
                {(props) => (
                  <Input
                    {...props}
                    value={draft.description}
                    onChange={(event) =>
                      update("description", event.target.value)
                    }
                    maxLength={500}
                    placeholder="e.g. Finds and summarizes research"
                  />
                )}
              </Field>
            </fieldset>
            <div className="agent-instructions-field" data-agent-section="Instructions" tabIndex={-1}>
              <Field
                label="Instructions"
                hintPosition="before"
                error={instructionsTooLong ? "Shorten instructions to 50,000 characters or fewer, including Markdown formatting." : undefined}
              >
                {(props) => (
                  <div className="composer agent-instructions-editor">
                    <MarkdownComposer
                      {...props}
                      mode="document"
                      label="Instructions"
                      disabled={busy}
                      readOnly={false}
                      value={draft.instructions}
                      onChange={(instructions) => update("instructions", instructions)}
                      placeholder="e.g. Compare sources, explain uncertainty, and cite the evidence."
                    />
                  </div>
                )}
              </Field>
            </div>
            <details className="agent-settings-section" data-agent-section="Model" tabIndex={-1} open>
              <summary><strong>Model</strong><span>{model?.name || draft.modelId || "Not configured"} · {thinkingLabel(draft.thinkingLevel)} thinking</span></summary>
            <fieldset disabled={busy} className="agent-form-section">
              <legend className="sr-only">Model settings</legend>
              <Field label="Runtime" hint={sdk ? `Runs the native ${backend === "muse-code" ? "Muse Code" : "Claude Code"} runtime.` : undefined}>
                {props => <Select {...props} value={backend} onChange={event => changeRuntime(event.target.value as ExecutionBackend)}>
                  <option value="pi">Pi</option>
                  <option value="claude-agent-sdk">Agent SDK</option>
                  <option value="muse-code">Muse Code</option>
                </Select>}
              </Field>
              <div className="form-columns">
                <Field label="Model" error={sdk && !model ? "Native model unavailable. Reload or ask your operator to check the catalog." : undefined}>
                  {(props) => (
                    <Select
                      {...props}
                      value={modelKey}
                      required
                      onChange={(event) => {
                        const [provider, modelId] = JSON.parse(
                          event.target.value,
                        ) as [string, string];
                        const selected = models.find(
                          (model) =>
                            model.provider === provider && model.id === modelId,
                        )!;
                        onChange({
                          ...editing,
                          draft: {
                            ...draft,
                            provider,
                            modelId,
                            thinkingLevel: selected.thinkingLevels.includes(
                              draft.thinkingLevel,
                            )
                              ? draft.thinkingLevel
                              : selected.thinkingLevels[0],
                          },
                        });
                      }}
                    >
                      {!model ? (
                        <option value={modelKey} disabled>
                          {draft.modelId || "No models available"}
                        </option>
                      ) : null}
                      {models.map((model) => (
                        <option
                          key={JSON.stringify([model.provider, model.id])}
                          value={JSON.stringify([model.provider, model.id])}
                        >
                          {model.name}{!sdk ? ` · ${model.provider}` : ""}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
                <Field label="Thinking level">
                  {(props) => (
                    <Select
                      {...props}
                      value={draft.thinkingLevel}
                      onChange={(event) =>
                        update(
                          "thinkingLevel",
                          event.target.value as ThinkingLevel,
                        )
                      }
                      disabled={!model}
                    >
                      {model?.thinkingLevels.map((level) => (
                        <option key={level} value={level}>
                          {thinkingLabel(level)}
                        </option>
                      ))}
                    </Select>
                  )}
                </Field>
              </div>
              {sdk ? <p className="field-hint">
                Sign in with {backend === "muse-code" ? "Muse Code" : "Claude Code"} on the runner. {" "}
                <a href={`https://github.com/dispatchlabs-ai/dispatch/blob/main/packages/web/docs/usage-guide.md#${backend === "muse-code" ? "muse-code-setup" : "claude-agent-sdk-setup"}`} target="_blank" rel="noopener noreferrer">Setup guide<span className="sr-only"> (opens in a new tab)</span></a>
              </p> : null}
            </fieldset>
            </details>
            <details className="agent-settings-section" data-agent-section="Capabilities" tabIndex={-1} open>
              <summary><strong>Capabilities</strong><span>{describeCapabilities(draft.capabilities)}</span></summary>
              <label className="choice-row capability-choice"><input type="checkbox" disabled={busy} checked={draft.capabilities?.includes("files-and-commands") ?? false} onChange={event => update("capabilities", event.target.checked ? [...(draft.capabilities ?? []), "files-and-commands"] : (draft.capabilities ?? []).filter(capability => capability !== "files-and-commands"))} /><span>Files and commands<small>Read and edit files, and run commands in the agent's working directory. Commands use the Dispatch service account.</small></span></label>
              <label className="choice-row capability-choice"><input type="checkbox" disabled={busy} checked={draft.capabilities?.includes("image-generation") ?? false} onChange={event => update("capabilities", event.target.checked ? [...(draft.capabilities ?? []), "image-generation"] : (draft.capabilities ?? []).filter(capability => capability !== "image-generation"))} /><span>Image generation<small>OpenAI · paid generation and editing</small></span></label>
              <label className="choice-row capability-choice"><input type="checkbox" disabled={busy} checked={draft.capabilities?.includes("edit-definition-of-done") ?? false} onChange={event => update("capabilities", event.target.checked ? [...(draft.capabilities ?? []), "edit-definition-of-done"] : (draft.capabilities ?? []).filter(capability => capability !== "edit-definition-of-done"))} /><span>Edit Definition of Done<small>Update shared chat completion criteria</small></span></label>
              <label className="choice-row capability-choice"><input type="checkbox" disabled={busy} checked={draft.capabilities?.includes("web-reading") ?? false} onChange={event => update("capabilities", event.target.checked ? [...(draft.capabilities ?? []), "web-reading"] : (draft.capabilities ?? []).filter(capability => capability !== "web-reading"))} /><span>Web reading<small>Open public pages, find text and follow links; no key required</small></span></label>
              <label className="choice-row capability-choice"><input type="checkbox" disabled={busy} checked={draft.capabilities?.includes("web-search") ?? false} onChange={event => update("capabilities", event.target.checked ? [...(draft.capabilities ?? []), "web-search"] : (draft.capabilities ?? []).filter(capability => capability !== "web-search"))} /><span>Web search<small>Search for sources; requires an Exa grant in Settings → Secrets</small></span></label>
            </details>
            <div data-agent-section="Secrets" tabIndex={-1}>{agent ? <NamedSecrets agentId={agent.id} disabled={busy || agent.archived} /> : <p>Save this agent before granting secrets.</p>}</div>
            <div data-agent-section="Skills" tabIndex={-1}><AgentSkillsEditor selections={draft.skills ?? []} onChange={skills => update("skills", skills)} busy={busy}
              editing={editing.skillEditing} onEditingChange={skillEditing => onChange({ ...editing, skillEditing, busy: skillEditing?.busy ?? false })} /></div>
            <div data-agent-section="Connections" tabIndex={-1}><AgentConnectionsEditor agent={agent} selectedIds={editing.connectionIds} busy={busy}
              onChange={connectionIds => onChange({ ...editing, connectionIds })}
              applyExisting={editing.applyConnectionsToExisting} onApplyExisting={applyConnectionsToExisting => onChange({ ...editing, applyConnectionsToExisting })}
              onSettings={onConnectionsSettings} /></div>
          </div>
        </div>
        <footer className="agent-editor-actions">
          <div className="agent-editor-actions-inner">
          <p className="editor-note">{agentConnectionsChanged(editing) && editing.applyConnectionsToExisting ? "Base and connection updates apply when idle." : "Base updates apply to existing instances when idle."}</p>
          <div className="button-row">
            <Button variant="secondary" disabled={busy} onClick={onCancel}>
              Discard
            </Button>
            <Button type="submit" disabled={busy || Boolean(editing.skillEditing) || !model || conflict || instructionsTooLong || Boolean(agent && !dirty)}>
              {busy ? <Spinner label="Saving agent" /> : null}
              {agent ? "Save new revision" : "Create agent"}
            </Button>
          </div>
          </div>
        </footer>
      </form>
    </section>
  );
}

function describeCapabilities(capabilities: AgentDraft["capabilities"]) {
  return capabilities?.map(capability => capability === "files-and-commands" ? "Files and commands" : capability === "web-reading" ? "Web reading" : capability === "web-search" ? "Web search" : capability === "edit-definition-of-done" ? "Edit Definition of Done" : "Image generation").join(", ") || "Conversation only";
}
