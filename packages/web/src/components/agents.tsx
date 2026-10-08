import { ArrowRight, Archive, Pencil } from "lucide-react";
import { useRef, useState } from "react";
import type {
  AgentDefinition,
  AgentDraft,
  ApplicationConfig,
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
  const model = config.models.find(
    (model) => model.provider === agent.provider && model.id === agent.modelId,
  );
  return (
    <section className="agent-view">
      <header className="view-heading agent-heading">
        <div>
          <h1>{agent.name}{evaluationOpen ? " / Evaluation profile" : ""}</h1>
          <p>
            {agent.archived
              ? "Archived agent"
              : isDefault
                ? "Default agent · Shared with your company"
                : "Shared with your company"}
          </p>
        </div>
        {!agent.archived && !evaluationOpen ? (
          <div className="button-row agent-actions">
            <Button variant="ghost" onClick={() => onEdit(agent)}>
              <Pencil /> Edit
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
      <div className={evaluationOpen ? "agent-content evaluation-workspace" : "agent-content"}>
        <div className="agent-content-inner">
          <div hidden={evaluationOpen}>
          <p className="agent-phone-facts">
            {model?.name || agent.modelId || "No model configured"} ·{" "}
            {thinkingLabel(agent.thinkingLevel)} thinking · {agent.tools.length || agent.skills?.length ? `${agent.tools.length + (agent.skills?.length ? 1 : 0)} tools` : "No tools"}
          </p>
          <p className="agent-description">
            {agent.description || "No description added."}
          </p>
          <section className="agent-instructions">
            <h2>Instructions</h2>
            <Markdown>
              {agent.instructions || "No additional instructions."}
            </Markdown>
          </section>
          <Button className="evaluation-entry" variant="secondary" onClick={() => { onEvaluationAgentChange(agent.id); }}>Configure evaluations</Button>
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
  const modelName = (provider: string, id: string) =>
    config?.models.find(
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
        <h2>{editing ? "Draft preview" : "Agent details"}</h2>
      </header> : null}
      <div className="context-body">
        {current ? (
          <>
            <div className="context-title">
              <h2>{current.name || "Untitled agent"}</h2>
              <span className="revision-badge">
                {editing ? agentEditIsDirty(editing) ? "Unsaved changes" : "Draft" : `Revision ${saved!.revision}`}
              </span>
            </div>
            {editing ? (
              <p className="context-description">
                {saved
                  ? `Saved configuration: revision ${saved.revision}. Changed settings are marked below.`
                  : "Not saved yet. Your settings update here as you edit."}
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
                label="Model"
                value={modelName(current.provider, current.modelId)}
                saved={
                  editing && saved
                    ? modelName(saved.provider, saved.modelId)
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
                <dd>{editing ? `${describeCapabilities(editing.draft.capabilities)} · ${editing.connectionIds.length + (saved?.connections?.filter(connection => connection.source !== "oauth").length ?? 0)} connections` : describeAgentTools([...(saved?.tools ?? []), ...(saved?.skills?.length ? ["load_skill"] : [])])}</dd>
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
  const [capabilitiesOpen] = useState(() => typeof window === "undefined" || window.innerWidth > 600);
  const saveRequest = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const dirty = agentEditIsDirty(editing);
  const instructionsTooLong = draft.instructions.length > 50000;
  const model = config.models.find(
    (model) => model.provider === draft.provider && model.id === draft.modelId,
  );
  const modelKey = JSON.stringify([draft.provider, draft.modelId]);
  function update<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) {
    onChange({ ...editing, draft: { ...draft, [key]: value } });
  }

  return (
    <section className="agent-editor agent-view">
      <header className="view-heading agent-heading">
        <div>
          <p className="page-eyebrow">Agents / {agent?.name || "New agent"}</p>
          <h1>{agent ? "Edit definition" : "New agent"}</h1>
          <p>
            {agent
              ? `Based on revision ${agent.revision}. Saving creates a new revision.`
              : "Shared with your company"}
          </p>
        </div>
        <span className="revision-badge">{dirty ? "Unsaved changes" : agent ? `Revision ${agent.revision}` : "Draft"}</span>
      </header>
      <form
        className="agent-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (instructionsTooLong || editing.skillEditing) return;
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
            <fieldset disabled={busy} className="agent-form-section">
              <legend>Identity</legend>
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
              <Field
                label="Description"
                hint="Help your teammates know when to use this agent."
              >
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
            <div className="agent-instructions-field">
              <Field
                label="Instructions"
                hint="Describe its role and what makes a useful result. Markdown formats as you type or paste."
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
            <details className="agent-settings-section">
              <summary><strong>Model</strong><span>{model?.name || draft.modelId || "Not configured"} · {thinkingLabel(draft.thinkingLevel)} thinking</span></summary>
            <fieldset disabled={busy} className="agent-form-section">
              <legend className="sr-only">Model settings</legend>
              <div className="form-columns">
                <Field label="Model">
                  {(props) => (
                    <Select
                      {...props}
                      value={modelKey}
                      required
                      onChange={(event) => {
                        const [provider, modelId] = JSON.parse(
                          event.target.value,
                        ) as [string, string];
                        const selected = config.models.find(
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
                      {config.models.map((model) => (
                        <option
                          key={JSON.stringify([model.provider, model.id])}
                          value={JSON.stringify([model.provider, model.id])}
                        >
                          {model.name} · {model.provider}
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
            </fieldset>
            </details>
            <details className="agent-settings-section" open={capabilitiesOpen}>
              <summary><strong>Capabilities</strong><span>{describeCapabilities(draft.capabilities)}</span></summary>
              <label className="choice-row capability-choice"><input type="checkbox" disabled={busy} checked={draft.capabilities?.includes("files-and-commands") ?? false} onChange={event => update("capabilities", event.target.checked ? [...(draft.capabilities ?? []), "files-and-commands"] : (draft.capabilities ?? []).filter(capability => capability !== "files-and-commands"))} /><span>Files and commands<small>Read and edit files, and run commands in the agent's working directory. Commands use the Dispatch service account.</small></span></label>
              <label className="choice-row capability-choice"><input type="checkbox" disabled={busy} checked={draft.capabilities?.includes("image-generation") ?? false} onChange={event => update("capabilities", event.target.checked ? [...(draft.capabilities ?? []), "image-generation"] : (draft.capabilities ?? []).filter(capability => capability !== "image-generation"))} /><span>Image generation<small>OpenAI · paid generation and editing</small></span></label>
            </details>
            <AgentSkillsEditor selections={draft.skills ?? []} onChange={skills => update("skills", skills)} busy={busy}
              editing={editing.skillEditing} onEditingChange={skillEditing => onChange({ ...editing, skillEditing, busy: skillEditing?.busy ?? false })} />
            <AgentConnectionsEditor agent={agent} selectedIds={editing.connectionIds} busy={busy}
              onChange={connectionIds => onChange({ ...editing, connectionIds })}
              applyExisting={editing.applyConnectionsToExisting} onApplyExisting={applyConnectionsToExisting => onChange({ ...editing, applyConnectionsToExisting })}
              onSettings={onConnectionsSettings} />
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
  return capabilities?.map(capability => capability === "files-and-commands" ? "Files and commands" : "Image generation").join(", ") || "Conversation only";
}
