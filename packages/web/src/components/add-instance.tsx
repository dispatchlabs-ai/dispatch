import { useRef, useState } from "react";
import type { AgentDefinition, ChatSnapshot, CreateAgentInstanceInput, CreateAgentInstanceResult } from "../shared/contracts";
import { mentionLabel, type MentionParticipant } from "../lib/mentions";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Markdown } from "./markdown";
import { MarkdownComposer } from "./markdown-composer";
import { Button, Field, Input, Modal, Notice, Select, Spinner } from "./ui";

export type OpenInstanceForm = (definitionId?: string, onCreated?: (participant: MentionParticipant) => void) => void;

export function AddInstanceDialog({ chatId, initialDefinitionId, agents, canParticipate, onSnapshot, onCreated, onClose, removingDefinitionIds }: {
  chatId: string; initialDefinitionId?: string; agents: AgentDefinition[]; canParticipate: boolean; removingDefinitionIds: string[];
  onSnapshot: (snapshot: ChatSnapshot) => void; onCreated?: (participant: MentionParticipant) => void; onClose: () => void;
}) {
  const { api } = useSession();
  const [definitionId, setDefinitionId] = useState(initialDefinitionId ?? "");
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = useRef<CreateAgentInstanceInput | null>(null);
  const agent = agents.find(agent => agent.id === definitionId && !agent.archived);
  const tooLong = instructions.length > 50000;
  const removing = removingDefinitionIds.includes(definitionId);
  const valid = Boolean(agent && !tooLong && name.length <= 100 && canParticipate && !removing);
  function close() {
    if (!busy && (!(name || instructions) || window.confirm("Discard this instance draft?"))) onClose();
  }
  async function create() {
    if (busy || !valid) return;
    const fields = { agentDefinitionId: definitionId, ...(name.trim() ? { name: name.trim() } : {}), ...(instructions ? { instructions } : {}) };
    const prior = request.current;
    if (!prior || prior.agentDefinitionId !== fields.agentDefinitionId || prior.name !== fields.name || prior.instructions !== fields.instructions) request.current = { requestId: crypto.randomUUID(), ...fields };
    setBusy(true); setError(null);
    try {
      const result = await api<CreateAgentInstanceResult>(`/api/chats/${encodeURIComponent(chatId)}/instances`, request.current!);
      onSnapshot(result);
      const participant = result.participants.find(person => person.id === result.createdParticipantId);
      if (participant?.kind === "agent" && participant.membership === "active") onCreated?.({ ...participant, name: mentionLabel(participant, result.participants) });
      else if (onCreated) { setError("This request already added an instance that is no longer active. Close and start a new request to add another."); return; }
      onClose();
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) request.current = null;
    } finally { setBusy(false); }
  }
  return <Modal title="Add agent instance" description="Separate context. Shared conversation." open onOpenChange={open => { if (!open) close(); }}>
    <form className="instance-form" onSubmit={event => { event.preventDefault(); void create(); }}>
      <Field label="Agent">{props => <Select {...props} value={definitionId} disabled={busy} onChange={event => setDefinitionId(event.target.value)}><option value="">Choose an agent</option>{agents.filter(agent => !agent.archived).map(agent => <option key={agent.id} value={agent.id} disabled={removingDefinitionIds.includes(agent.id)}>{agent.name}</option>)}</Select>}</Field>
      <Field label="Instance name (optional)" hint="Leave blank to use the agent’s name.">{props => <Input {...props} value={name} maxLength={100} disabled={busy} onChange={event => setName(event.target.value)} placeholder="e.g. Developer · Backend" />}</Field>
      {agent ? <details><summary>Base instructions · revision {agent.revision}</summary><Markdown>{agent.instructions || "No base instructions."}</Markdown></details> : null}
      <Field label="Additional instructions (optional)" hint="This instance only. Set at creation." hintPosition="before" error={tooLong ? "Shorten to 50,000 characters, including Markdown." : undefined}>{props => <div className="composer instance-instructions-editor"><MarkdownComposer {...props} mode="document" label="Additional instructions" value={instructions} onChange={setInstructions} disabled={busy} readOnly={false} placeholder="e.g. Own API changes; coordinate with the frontend developer." /></div>}</Field>
      {removing ? <Notice>Removal is still pending. Finish cleanup before adding an instance.</Notice> : null}
      {!canParticipate ? <Notice>Participation access is required.</Notice> : null}
      {error ? <Notice>{error} Your draft is kept.</Notice> : null}
      <div className="button-row"><Button variant="secondary" disabled={busy} onClick={close}>Cancel</Button><Button type="submit" disabled={busy || !valid}>{busy ? <Spinner label="Adding instance" /> : null}Add instance</Button></div>
    </form>
  </Modal>;
}
