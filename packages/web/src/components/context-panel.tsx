import { Tabs } from "@base-ui/react/tabs";
import { Bot, Gauge, LockKeyhole, ShieldCheck } from "lucide-react";
import type { AgentDefinition, ChatSnapshot } from "../shared/contracts";
import { chatAgent, chatUsage, statusLabels } from "../lib/chat";

export function ContextPanel({ kind, snapshot, definition, tab, onTabChange }: {
  kind: "chat" | "agents" | "security" | "welcome";
  snapshot?: ChatSnapshot;
  definition?: AgentDefinition;
  tab: string;
  onTabChange: (tab: string) => void;
}) {
  if (kind === "agents") return <div className="context-info"><span className="section-icon"><Bot /></span><h2>Reusable by your team</h2><p>Agent definitions are shared with everyone in this workspace. Give each one a clear purpose and instructions.</p><h3>New chats, fresh configuration</h3><p>Each save creates a new revision. Existing conversations keep the model and instructions they started with.</p><h3>Archiving an agent</h3><p>Archived agents cannot start new chats. Their existing conversations remain available.</p></div>;
  if (kind === "security") return <div className="context-info"><span className="section-icon"><ShieldCheck /></span><h2>Keep a way back in</h2><p>Set up a second passkey or add password and authenticator sign-in. Keep recovery codes in a safe place.</p><h3>Your access</h3><p>Changing a sign-in method requires a recent sign-in. Your conversations are private to your account.</p></div>;
  if (kind !== "chat") return null;
  if (!snapshot) return <div className="context-info"><p>Loading this conversation’s supporting information…</p></div>;
  const agent = chatAgent(snapshot);
  const usage = chatUsage(snapshot);
  const modelUsage = Object.entries(usage.models);
  const tokens = modelUsage.reduce((total, [, value]) => total + value.totalTokens, 0);
  const cost = modelUsage.reduce((total, [, value]) => total + value.cost.total, 0);
  const pending = snapshot.submissions.filter(submission => submission.status === "queued" || submission.status === "placed");

  return <Tabs.Root value={tab} onValueChange={value => onTabChange(String(value))} className="context-tabs">
    <Tabs.List className="context-tab-list" aria-label="Conversation supporting views"><Tabs.Tab value="agent"><Bot size={15} /> Agent</Tabs.Tab><Tabs.Tab value="run"><Gauge size={15} /> Run & usage</Tabs.Tab></Tabs.List>
    <Tabs.Panel value="agent" className="context-body">
      <div className="context-title"><h2>{definition?.revision === snapshot.conversation.agentRevision ? definition.name : "Saved agent setup"}</h2><span className="revision-badge">Revision {snapshot.conversation.agentRevision}</span></div>
      <p className="context-description">This conversation keeps the setup it started with.</p>
      <dl className="context-facts"><div><dt>Model</dt><dd>{agent.model?.modelId || "Not configured"}</dd></div><div><dt>Provider</dt><dd>{agent.model?.provider || "Not configured"}</dd></div><div><dt>Thinking</dt><dd className="capitalize">{agent.thinkingLevel || "Default"}</dd></div><div><dt>Tools</dt><dd>{Array.isArray(agent.tools) && agent.tools.length ? agent.tools.join(", ") : "No tools enabled"}</dd></div></dl>
      <section className="context-section"><h3>Instructions</h3><p className="saved-instructions">{agent.instructions || "No additional instructions."}</p></section>
      <p className="privacy-note"><LockKeyhole size={13} /> Only you can access this conversation.</p>
    </Tabs.Panel>
    <Tabs.Panel value="run" className="context-body">
      <div className="context-title"><h2>Current run</h2><span className={`status-badge status-${snapshot.conversation.status}`}>{statusLabels[snapshot.conversation.status]}</span></div>
      <p className="context-description">{pending.length ? `${pending.length} message${pending.length === 1 ? " is" : "s are"} waiting for a completed response.` : "No messages are waiting for a response."}</p>
      <section className="context-section"><h3>Conversation usage</h3>{modelUsage.length ? <dl className="context-facts"><div><dt>Total tokens</dt><dd>{tokens.toLocaleString()}</dd></div><div><dt>Estimated cost</dt><dd>{new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(cost)}</dd></div></dl> : <p>No usage has been recorded yet.</p>}</section>
      {modelUsage.map(([model, value]) => <section className="context-section" key={model}><h3 className="model-label">{model}</h3><dl className="context-facts"><div><dt>Input tokens</dt><dd>{value.input.toLocaleString()}</dd></div><div><dt>Output tokens</dt><dd>{value.output.toLocaleString()}</dd></div><div><dt>Cached input</dt><dd>{value.cacheRead.toLocaleString()}</dd></div></dl></section>)}
      {snapshot.submissions.length ? <details className="delivery-details"><summary>Message delivery</summary><ul>{snapshot.submissions.map(submission => <li key={submission.id}><span>{submission.type === "input" ? "Message" : "Entry"}</span><strong>{submission.status === "done" ? "Completed" : submission.status === "unanswered" ? submission.reason : submission.status === "placed" ? "In progress" : "Queued"}</strong></li>)}</ul></details> : null}
    </Tabs.Panel>
  </Tabs.Root>;
}
