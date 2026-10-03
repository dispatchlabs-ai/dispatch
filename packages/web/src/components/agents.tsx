import { ArrowLeft, ArrowRight, Archive, Bot, Pencil } from "lucide-react";
import { useState } from "react";
import type { AgentDefinition, AgentDraft, ApplicationConfig, SaveAgentInput, ThinkingLevel } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Modal, Notice, Spinner } from "./ui";

export type AgentEditing = AgentDefinition | "new" | null;

export function AgentsPage({ agent, editing, config, defaultAgent, onSaved, onCancel, onEdit, onStartChat, creating }: {
  agent?: AgentDefinition;
  editing: AgentEditing;
  config: ApplicationConfig;
  defaultAgent?: AgentDefinition;
  onSaved: (agent: AgentDefinition) => void;
  onCancel: () => void;
  onEdit: (agent: AgentDefinition) => void;
  onStartChat: (agentId: string) => void;
  creating: boolean;
}) {
  if (editing) return <AgentEditor
    key={editing === "new" ? "new" : editing.id}
    agent={editing === "new" ? undefined : editing} config={config} defaultAgent={defaultAgent}
    onCancel={onCancel} onSaved={onSaved} />;

  if (!agent) return <section className="agent-view">
    <header className="view-heading"><div><h1>Agents</h1><p>Shared with your company</p></div></header>
    <div className="page-state"><p>Choose an agent from the sidebar, or create a new one.</p></div>
  </section>;

  const isDefault = agent.id === config.defaultAgentId;
  return <section className="agent-view">
    <header className="view-heading agent-heading">
      <div><h1>{agent.name}</h1><p>{agent.archived ? "Archived agent" : isDefault ? "Default agent · Shared with your company" : "Shared with your company"}</p></div>
      {!agent.archived ? <div className="button-row">
        {!isDefault ? <Button variant="ghost" onClick={() => onEdit(agent)}><Pencil /> Edit</Button> : null}
        <Button variant="secondary" disabled={creating} onClick={() => onStartChat(agent.id)}>{creating ? <Spinner /> : <ArrowRight />} Start chat</Button>
      </div> : null}
    </header>
    <div className="agent-content">
      <section><h2>About</h2><p>{agent.description || "No description added."}</p></section>
      <section><h2>Instructions</h2><p className="saved-instructions">{agent.instructions || "No additional instructions."}</p></section>
      {agent.archived ? <Notice tone="info">This agent is archived. Existing conversations keep their saved configuration.</Notice>
        : isDefault ? <p className="editor-note">Your operator manages this agent’s configuration.</p> : null}
    </div>
  </section>;
}

export function AgentArchiveDialog({ agent, onClose, onSaved, onRefresh }: {
  agent: AgentDefinition;
  onClose: () => void;
  onSaved: (agent: AgentDefinition) => void;
  onRefresh: () => Promise<void>;
}) {
  const { api } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return <Modal title={`Archive ${agent.name}?`}
    description="This agent will no longer be available for new chats. Existing conversations will keep their saved configuration."
    open onOpenChange={open => { if (!open && !busy) onClose(); }}
    finalFocus={() => document.getElementById("main-workspace")}>
    {error ? <Notice>{error}</Notice> : null}
    <div className="button-row">
      <Button variant="secondary" disabled={busy} onClick={onClose}>Keep agent</Button>
      <Button variant="danger" disabled={busy} onClick={() => {
        setBusy(true); setError(null);
        void api<{ agent: AgentDefinition }>(`/api/agents/${encodeURIComponent(agent.id)}/archive`, { expectedRevision: agent.revision })
          .then(({ agent }) => { onSaved(agent); onClose(); })
          .catch(error => { setError(errorMessage(error)); if (error instanceof ApiError && error.status === 409) void onRefresh(); })
          .finally(() => setBusy(false));
      }}>{busy ? <Spinner /> : <Archive />} Archive agent</Button>
    </div>
  </Modal>;
}

export function AgentDetails({ agent, editing }: { agent?: AgentDefinition; editing: AgentEditing }) {
  const saved = editing && editing !== "new" ? editing : agent;
  return <div className="context-empty">
    <header className="context-header"><h2>{editing && editing !== "new" ? "Saved configuration" : "Agent details"}</h2></header>
    <div className="context-body">
      {editing === "new" ? <p>This agent hasn’t been saved yet.</p> : saved ? <>
        <div className="context-title"><h2>{saved.name}</h2><span className="revision-badge">Revision {saved.revision}</span></div>
        {editing ? <p className="context-description">These are the saved settings. Your changes remain in the editor until you save.</p> : null}
        <dl className="context-facts">
          <div><dt>Status</dt><dd>{saved.archived ? "Archived" : "Active"}</dd></div>
          <div><dt>Model</dt><dd>{saved.modelId || "Not configured"}</dd></div>
          <div><dt>Provider</dt><dd>{saved.provider || "Not configured"}</dd></div>
          <div><dt>Thinking</dt><dd>{saved.thinkingLevel === "off" ? "Off" : saved.thinkingLevel[0].toUpperCase() + saved.thinkingLevel.slice(1)}</dd></div>
          <div><dt>Tools</dt><dd>No tools enabled</dd></div>
        </dl>
      </> : <p>No agent selected.</p>}
    </div>
  </div>;
}

function AgentEditor({
  agent,
  config,
  defaultAgent,
  onSaved,
  onCancel,
}: {
  agent?: AgentDefinition;
  config: ApplicationConfig;
  onSaved: (agent: AgentDefinition) => void;
  onCancel: () => void;
  defaultAgent?: AgentDefinition;
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
  function cancel() {
    if (dirty) setDiscarding(true);
    else onCancel();
  }

  function update<K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) {
    setDraft((current) => ({ ...current, [key]: value }));
  }

  return (
    <section className="agent-editor agent-view">
      <header className="view-heading agent-heading">
        <div>
          <h1>{agent ? `Edit ${agent.name}` : "New agent"}</h1>
          <p>{agent ? `Saving creates revision ${agent.revision + 1}. Existing chats keep their current setup.` : "Shared with your company"}</p>
        </div>
        <Button variant="ghost" disabled={busy} onClick={cancel}><ArrowLeft /> Back</Button>
      </header>
      <div className="agent-content">
      {error ? (
        <Notice>
          {error}
          {conflict
            ? " Your changes are still here. Copy anything you want to keep, then go back and reopen the latest revision."
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
              autoFocus
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
      </div>
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
