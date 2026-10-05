import { Bot, Check, UserRound } from "lucide-react";
import { useState } from "react";
import type { AgentDefinition } from "../shared/contracts";
import { SidebarSearch } from "./sidebar-search";
import { Button, Modal, Notice, Spinner } from "./ui";

export function ParticipantAvatar({ kind, name }: { kind: "human" | "agent"; name: string }) {
  return <span className={`participant-avatar participant-${kind}`} aria-hidden="true">{kind === "agent" ? <Bot size={20} /> : name.trim() ? name.trim().slice(0, 1).toUpperCase() : <UserRound size={20} />}</span>;
}

export function AgentChoices({ agents, selected, onChange, disabled = false, joinedDefinitionIds = [] }: {
  agents: AgentDefinition[]; selected: string[]; onChange: (ids: string[]) => void; disabled?: boolean; joinedDefinitionIds?: string[];
}) {
  const [search, setSearch] = useState("");
  const available = agents.filter(agent => !agent.archived && `${agent.name} ${agent.description}`.toLowerCase().includes(search.toLowerCase()));
  return <div className="participant-choices">
    <SidebarSearch label="Find an agent" value={search} onChange={setSearch} />
    <div className="participant-choice-list">
      {available.map(agent => {
        const joined = joinedDefinitionIds.includes(agent.id);
        const identity = <><ParticipantAvatar kind="agent" name={agent.name} /><span className="participant-choice-copy"><strong>{agent.name}</strong><span>{agent.description || "Company agent"}</span></span></>;
        return joined ? <div className="participant-choice" key={agent.id}>{identity}<span className="status-badge">Already here</span></div> : <label className={`participant-choice ${selected.includes(agent.id) ? "selected" : ""}`} key={agent.id}>
          {identity}
          <input type="checkbox" checked={selected.includes(agent.id)} disabled={disabled} onChange={event => onChange(event.target.checked ? [...selected, agent.id] : selected.filter(id => id !== agent.id))} />
          <span className="participant-check" aria-hidden="true">{selected.includes(agent.id) ? <Check size={16} /> : null}</span>
        </label>;
      })}
      {!available.length ? <p className="collection-empty">{search ? "No agents match your search." : "No agents are available."}</p> : null}
    </div>
  </div>;
}

export function NewConversationDialog({ agents, initialAgentIds, projectName, busy, error, onClose, onCreate }: {
  agents: AgentDefinition[]; initialAgentIds: string[]; projectName?: string; busy: boolean; error?: string | null;
  onClose: () => void; onCreate: (agentIds: string[]) => void;
}) {
  const [selected, setSelected] = useState(initialAgentIds);
  return <Modal title="New conversation" description={projectName ? `Project: ${projectName}` : "Without a project"} open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <div className="conversation-picker">
      <p>Choose agents to start with. You can add people and agents later.</p>
      <AgentChoices agents={agents} selected={selected} onChange={setSelected} disabled={busy} />
      {error ? <Notice>{error}</Notice> : null}
      <footer className="picker-actions"><span>{selected.length} {selected.length === 1 ? "agent" : "agents"} selected</span><div className="button-row">
        <Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button>
        <Button disabled={busy || !selected.length} onClick={() => onCreate(selected)}>{busy ? <Spinner /> : null} Start conversation</Button>
      </div></footer>
    </div>
  </Modal>;
}
