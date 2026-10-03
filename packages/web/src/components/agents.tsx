import {
  ArrowLeft,
  ArrowRight,
  Archive,
  Bot,
  Pencil,
  Plus,
} from "lucide-react";
import { useEffect, useState } from "react";
import type {
  AgentDefinition,
  AgentDraft,
  ApplicationConfig,
  SaveAgentInput,
  ThinkingLevel,
} from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Modal, Notice, Spinner } from "./ui";

export function AgentsPage({
  agents,
  config,
  onSaved,
  onRefresh,
  onStartChat,
  creating,
  onDirtyChange,
}: {
  agents: AgentDefinition[];
  config: ApplicationConfig;
  onSaved: (agent: AgentDefinition) => void;
  onRefresh: () => Promise<void>;
  onStartChat: (agentId: string) => void;
  creating: boolean;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { api } = useSession();
  const [editing, setEditing] = useState<AgentDefinition | "new" | null>(null);
  const [archiving, setArchiving] = useState<AgentDefinition | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    if (!editing) onDirtyChange?.(busy);
  }, [editing, busy, onDirtyChange]);

  if (editing)
    return (
      <AgentEditor
        key={typeof editing === "string" ? "new" : editing.id}
        agent={editing === "new" ? undefined : editing}
        config={config}
        defaultAgent={agents.find(
          (agent) => agent.id === config.defaultAgentId,
        )}
        onDirtyChange={onDirtyChange}
        onCancel={() => {
          setEditing(null);
          void onRefresh();
        }}
        onSaved={(agent) => {
          onSaved(agent);
          setEditing(null);
        }}
      />
    );

  return (
    <section className="agents-page">
      <header className="page-heading">
        <div>
          <span className="eyebrow">Your team’s agents</span>
          <h1>Agents</h1>
          <p>
            Save a useful setup. Start a fresh conversation whenever you need
            it.
          </p>
        </div>
        <Button
          onClick={() => {
            setError(null);
            setEditing("new");
          }}
        >
          <Plus /> New agent
        </Button>
      </header>
      {error ? <Notice>{error}</Notice> : null}
      <div className="agent-filter">
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />{" "}
          Show archived agents
        </label>
        <span>{agents.filter((agent) => !agent.archived).length} active</span>
      </div>
      <div className="agent-list">
        {agents
          .filter((agent) => showArchived || !agent.archived)
          .map((agent) => (
            <article
              className={`agent-card ${agent.archived ? "agent-archived" : ""}`}
              key={agent.id}
            >
              <div className="agent-card-heading">
                <span className="agent-icon">
                  <Bot size={20} />
                </span>
                <div>
                  <h2>{agent.name}</h2>
                  <p>
                    {agent.archived
                      ? "Archived"
                      : agent.id === config.defaultAgentId
                        ? "Default agent"
                        : `Revision ${agent.revision}`}
                  </p>
                </div>
              </div>
              <p className="agent-description">
                {agent.description || "No description added."}
              </p>
              <div className="agent-model">
                {agent.modelId}
                <span>{agent.provider}</span>
              </div>
              {!agent.archived ? (
                <div className="agent-card-actions">
                  <Button
                    variant="secondary"
                    disabled={creating}
                    onClick={() => onStartChat(agent.id)}
                  >
                    Start chat <ArrowRight />
                  </Button>
                  {agent.id !== config.defaultAgentId ? (
                    <div>
                      <Button
                        variant="ghost"
                        onClick={() => setEditing(agent)}
                        aria-label={`Edit ${agent.name}`}
                      >
                        <Pencil /> Edit
                      </Button>
                      <Button
                        variant="ghost"
                        onClick={() => {
                          setError(null);
                          setArchiving(agent);
                        }}
                        aria-label={`Archive ${agent.name}`}
                      >
                        <Archive />
                      </Button>
                    </div>
                  ) : (
                    <span className="editor-note">
                      Managed by your operator
                    </span>
                  )}
                </div>
              ) : (
                <p className="archived-note">
                  Existing conversations keep this agent’s configuration.
                </p>
              )}
            </article>
          ))}
      </div>
      {!agents.length ? (
        <div className="page-state">
          <p>No agents are available yet.</p>
          <Button onClick={() => setEditing("new")}>
            <Plus /> Create an agent
          </Button>
        </div>
      ) : null}
      <Modal
        title={`Archive ${archiving?.name || "agent"}?`}
        description="This agent will no longer be available for new chats. Existing conversations will keep their saved configuration."
        open={!!archiving}
        onOpenChange={(open) => {
          if (!open && !busy) setArchiving(null);
        }}
      >
        {error ? <Notice>{error}</Notice> : null}
        <div className="button-row">
          <Button
            variant="secondary"
            disabled={busy}
            onClick={() => setArchiving(null)}
          >
            Keep agent
          </Button>
          <Button
            variant="danger"
            disabled={busy}
            onClick={() => {
              if (!archiving) return;
              setBusy(true);
              setError(null);
              void api<{ agent: AgentDefinition }>(
                `/api/agents/${encodeURIComponent(archiving.id)}/archive`,
                { expectedRevision: archiving.revision },
              )
                .then(({ agent }) => {
                  onSaved(agent);
                  setArchiving(null);
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
    </section>
  );
}

function AgentEditor({
  agent,
  config,
  defaultAgent,
  onSaved,
  onCancel,
  onDirtyChange,
}: {
  agent?: AgentDefinition;
  config: ApplicationConfig;
  onSaved: (agent: AgentDefinition) => void;
  onCancel: () => void;
  defaultAgent?: AgentDefinition;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const { api } = useSession();
  const [initialDraft] = useState<AgentDraft>(() =>
    agent
      ? {
          name: agent.name,
          description: agent.description,
          instructions: agent.instructions,
          provider: agent.provider,
          modelId: agent.modelId,
          thinkingLevel: agent.thinkingLevel,
        }
      : {
          name: "",
          description: "",
          instructions: "",
          provider: defaultAgent?.provider || "",
          modelId: defaultAgent?.modelId || "",
          thinkingLevel: defaultAgent?.thinkingLevel || "off",
        },
  );
  const [draft, setDraft] = useState(initialDraft);
  const [busy, setBusy] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const model = config.models.find(
    (model) => model.provider === draft.provider && model.id === draft.modelId,
  );
  const modelKey = JSON.stringify([draft.provider, draft.modelId]);

  const dirty = (Object.keys(initialDraft) as (keyof AgentDraft)[]).some(
    (key) => draft[key] !== initialDraft[key],
  );
  useEffect(() => {
    onDirtyChange?.(dirty || busy);
  }, [dirty, busy, onDirtyChange]);
  function cancel() {
    if (dirty) setDiscarding(true);
    else onCancel();
  }

  function update<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="agent-editor settings-page">
      <Button
        className="back-button"
        variant="ghost"
        disabled={busy}
        onClick={cancel}
      >
        <ArrowLeft /> Back to agents
      </Button>
      <header className="page-heading">
        <div>
          <span className="eyebrow">Shared with your company</span>
          <h1>{agent ? "Edit agent" : "Create an agent"}</h1>
          <p>
            {agent
              ? `Saving creates revision ${agent.revision + 1}. Existing chats keep their current setup.`
              : "Give your agent a purpose and a clear set of instructions."}
          </p>
        </div>
      </header>
      {error ? (
        <Notice>
          {error}
          {conflict
            ? " Your changes are still here. Copy anything you want to keep, then return to the catalog and reopen the latest revision."
            : ""}
        </Notice>
      ) : null}
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          setBusy(true);
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
            })
            .finally(() => setBusy(false));
        }}
      >
        <Field label="Name">
          {(props) => (
            <Input
              {...props}
              value={draft.name}
              onChange={(event) => update("name", event.target.value)}
              required
              maxLength={100}
              placeholder="Research partner"
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
              onChange={(event) => update("description", event.target.value)}
              maxLength={500}
              placeholder="What this agent does"
            />
          )}
        </Field>
        <div className="form-columns">
          <Field label="Model">
            {(props) => (
              <select
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
                  setDraft((current) => ({
                    ...current,
                    provider,
                    modelId,
                    thinkingLevel: selected.thinkingLevels.includes(
                      current.thinkingLevel,
                    )
                      ? current.thinkingLevel
                      : selected.thinkingLevels[0],
                  }));
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
              </select>
            )}
          </Field>
          <Field label="Thinking level">
            {(props) => (
              <select
                {...props}
                value={draft.thinkingLevel}
                onChange={(event) =>
                  update("thinkingLevel", event.target.value as ThinkingLevel)
                }
                disabled={!model}
              >
                {model?.thinkingLevels.map((level) => (
                  <option key={level} value={level}>
                    {level.charAt(0).toUpperCase() + level.slice(1)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field
          label="Instructions"
          hint="Describe the agent’s role, how it should approach the work, and what makes a useful result."
        >
          {(props) => (
            <textarea
              {...props}
              rows={10}
              maxLength={50000}
              value={draft.instructions}
              onChange={(event) => update("instructions", event.target.value)}
              placeholder="You are…"
            />
          )}
        </Field>
        <p className="editor-note">
          This version supports conversation only. No tools are enabled.
        </p>
        <div className="button-row">
          <Button type="submit" disabled={busy || !model || conflict}>
            {busy ? <Spinner label="Saving agent" /> : <Bot size={17} />}{" "}
            {agent ? "Save new revision" : "Create agent"}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={cancel}>
            Cancel
          </Button>
        </div>
      </form>
      <Modal
        title="Discard agent changes?"
        description="Your unsaved changes will be lost."
        open={discarding}
        onOpenChange={setDiscarding}
      >
        <div className="button-row">
          <Button variant="secondary" onClick={() => setDiscarding(false)}>
            Keep editing
          </Button>
          <Button variant="danger" onClick={onCancel}>
            Discard changes
          </Button>
        </div>
      </Modal>
    </section>
  );
}
