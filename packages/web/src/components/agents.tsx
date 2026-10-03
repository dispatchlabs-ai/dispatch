import { ArrowRight, Archive, Pencil } from "lucide-react";
import { useState } from "react";
import type {
  AgentDefinition,
  AgentDraft,
  ApplicationConfig,
  SaveAgentInput,
  ThinkingLevel,
} from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Modal, Notice, Select, Spinner } from "./ui";

export type AgentEditing = {
  key: string;
  saved?: AgentDefinition;
  initialDraft: AgentDraft;
  draft: AgentDraft;
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
  };
  return {
    key: crypto.randomUUID(),
    saved,
    initialDraft,
    draft: initialDraft,
    busy: false,
  };
}

export function agentEditIsDirty(editing: AgentEditing) {
  return (Object.keys(editing.initialDraft) as (keyof AgentDraft)[]).some(
    (key) => editing.draft[key] !== editing.initialDraft[key],
  );
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
}: {
  agent?: AgentDefinition;
  editing: AgentEditing | null;
  config: ApplicationConfig;
  onEditingChange: (editing: AgentEditing) => void;
  onSaved: (agent: AgentDefinition) => void;
  onCancel: () => void;
  onEdit: (agent: AgentDefinition) => void;
  onStartChat: (agentId: string) => void;
  creating: boolean;
}) {
  if (editing)
    return (
      <AgentEditor
        key={editing.key}
        editing={editing}
        config={config}
        onChange={onEditingChange}
        onCancel={onCancel}
        onSaved={onSaved}
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
          <h1>{agent.name}</h1>
          <p>
            {agent.archived
              ? "Archived agent"
              : isDefault
                ? "Default agent · Shared with your company"
                : "Shared with your company"}
          </p>
        </div>
        {!agent.archived ? (
          <div className="button-row agent-actions">
            {!isDefault ? (
              <Button variant="ghost" onClick={() => onEdit(agent)}>
                <Pencil /> Edit
              </Button>
            ) : null}
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
      <div className="agent-content">
        <div className="agent-content-inner">
          <p className="agent-phone-facts">
            {model?.name || agent.modelId || "No model configured"} ·{" "}
            {thinkingLabel(agent.thinkingLevel)} thinking · No tools
          </p>
          <p className="agent-description">
            {agent.description || "No description added."}
          </p>
          <section className="agent-instructions">
            <h2>Instructions</h2>
            <p className="saved-instructions">
              {agent.instructions || "No additional instructions."}
            </p>
          </section>
          {agent.archived ? (
            <Notice tone="info">
              This agent is archived. Existing conversations keep their saved
              configuration.
            </Notice>
          ) : isDefault ? (
            <p className="editor-note">
              Your operator manages this agent’s configuration.
            </p>
          ) : null}
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
      description="This agent will no longer be available for new chats. Existing conversations will keep their saved configuration."
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
                {editing ? "Unsaved" : `Revision ${saved!.revision}`}
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
              <div>
                <dt>Tools</dt>
                <dd>No tools enabled</dd>
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
}: {
  editing: AgentEditing;
  config: ApplicationConfig;
  onChange: (editing: AgentEditing) => void;
  onSaved: (agent: AgentDefinition) => void;
  onCancel: () => void;
}) {
  const { api } = useSession();
  const { saved: agent, draft, busy } = editing;
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
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
          <h1>{agent ? `Edit ${agent.name}` : "New agent"}</h1>
          <p>
            {agent
              ? `Saving creates revision ${agent.revision + 1}. Existing chats keep their current setup.`
              : "Shared with your company"}
          </p>
        </div>
      </header>
      <form
        className="agent-editor-form"
        onSubmit={(event) => {
          event.preventDefault();
          onChange({ ...editing, busy: true });
          setError(null);
          setConflict(false);
          const input: SaveAgentInput = {
            ...draft,
            ...(agent
              ? { id: agent.id, expectedRevision: agent.revision }
              : {}),
          };
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
                  ? " Your changes are still here. Copy anything you want to keep, then cancel and reopen the latest revision."
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
                hint="How should this agent approach the work? Describe its role and what makes a useful result."
                hintPosition="before"
              >
                {(props) => (
                  <textarea
                    {...props}
                    disabled={busy}
                    rows={10}
                    maxLength={50000}
                    value={draft.instructions}
                    onChange={(event) =>
                      update("instructions", event.target.value)
                    }
                    placeholder="e.g. Compare sources, explain uncertainty, and cite the evidence."
                  />
                )}
              </Field>
            </div>
            <fieldset disabled={busy} className="agent-form-section">
              <legend>Model</legend>
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
          </div>
        </div>
        <footer className="agent-editor-actions">
          <div className="agent-editor-actions-inner">
          <p className="editor-note">Conversation only · No tools</p>
          <div className="button-row">
            <Button variant="secondary" disabled={busy} onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !model || conflict}>
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
