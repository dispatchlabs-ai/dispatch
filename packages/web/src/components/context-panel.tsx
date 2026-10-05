import { Tabs } from "@base-ui/react/tabs";
import { Bot, Gauge, LockKeyhole } from "lucide-react";
import type { ApplicationConfig, ChatSnapshot } from "../shared/contracts";
import { chatAgent, chatUsage, statusLabels } from "../lib/chat";

export function ContextPanel({ kind, snapshot, models, tab, onTabChange }: {
  kind: "chat" | "project" | "agents" | "security" | "welcome";
  snapshot?: ChatSnapshot;
  models: ApplicationConfig["models"];
  tab: string;
  onTabChange: (tab: string) => void;
}) {
  if (kind !== "chat" || !snapshot) return <div className="context-empty">
    <header className="context-header">
      <h2>Details</h2>
    </header>
    <div className="context-body">
      <p>{kind === "chat" ? "Loading conversation details…" : kind === "welcome" || kind === "project" ? "Open a conversation to see its agent setup and run details." : "No supporting view for this page."}</p>
    </div>
  </div>;
  const agent = chatAgent(snapshot);
  const model = models.find(model => model.provider === agent.model?.provider && model.id === agent.model?.modelId);
  const thinking = agent.thinkingLevel;
  const thinkingLabel = thinking ? thinking[0].toUpperCase() + thinking.slice(1) : "Default";
  const usage = chatUsage(snapshot);
  const modelUsage = Object.entries(usage.models);
  const tokens = modelUsage.reduce((total, [, value]) => total + value.totalTokens, 0);
  const cost = modelUsage.reduce((total, [, value]) => total + value.cost.total, 0);
  const pending = snapshot.submissions.filter(submission => submission.status === "queued" || submission.status === "placed");

  return <Tabs.Root value={tab} onValueChange={value => onTabChange(String(value))} className="context-tabs">
    <Tabs.List className="context-tab-list" aria-label="Conversation supporting views">
      <Tabs.Tab value="agent">
        <Bot size={15} /> Agent</Tabs.Tab>
      <Tabs.Tab value="run">
        <Gauge size={15} /> Run & usage</Tabs.Tab>
    </Tabs.List>
    <Tabs.Panel value="agent" className="context-body">
      <div className="context-title">
        <h2>{snapshot.conversation.agentName}</h2>
        <span className="revision-badge">Revision {snapshot.conversation.agentRevision}</span>
      </div>
      <p className="context-description">This conversation keeps the setup it started with.</p>
      <dl className="context-facts">
        <div>
          <dt>Model</dt>
          <dd>{model?.name || agent.model?.modelId || "Not configured"}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{agent.model?.provider || "Not configured"}</dd>
        </div>
        <div>
          <dt>Thinking</dt>
          <dd>{thinkingLabel}</dd>
        </div>
        <div>
          <dt>Tools</dt>
          <dd>{Array.isArray(agent.tools) && agent.tools.length ? agent.tools.join(", ") : "No tools enabled"}</dd>
        </div>
        {agent.cwd ? <div>
          <dt>Local workspace</dt>
          <dd>{agent.cwd}</dd>
        </div> : null}
      </dl>
      <section className="context-section">
        <h3>Instructions</h3>
        <p className="saved-instructions">{agent.instructions || "No additional instructions."}</p>
      </section>
      <p className="privacy-note">
        <LockKeyhole size={13} /> Only your account can open this conversation in Dispatch.</p>
      {agent.cwd ? <p className="context-description">Coding tools run on the service machine with its account’s access. The workspace is not a sandbox.</p> : null}
    </Tabs.Panel>
    <Tabs.Panel value="run" className="context-body">
      <div className="context-title">
        <h2>Current run</h2>
        <span className={`status-badge status-${snapshot.conversation.status}`}>{statusLabels[snapshot.conversation.status]}</span>
      </div>
      <p className="context-description">{pending.length ? `${pending.length} message${pending.length === 1 ? " is" : "s are"} waiting for a completed response.` : "No messages are waiting for a response."}</p>
      <section className="context-section">
        <h3>Conversation usage</h3>{modelUsage.length ? <dl className="context-facts">
          <div>
            <dt>Total tokens</dt>
            <dd>{tokens.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt>Estimated cost</dt>
            <dd>{new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(cost)}
            </dd>
          </div>
        </dl> : <p>No usage has been recorded yet.</p>}</section>
      {modelUsage.map(([model, value]) => <section className="context-section" key={model}>
        <h3 className="model-label">{model}</h3>
        <dl className="context-facts">
          <div>
            <dt>Input tokens</dt>
            <dd>{value.input.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt>Output tokens</dt>
            <dd>{value.output.toLocaleString()}
            </dd>
          </div>
          <div>
            <dt>Cached input</dt>
            <dd>{value.cacheRead.toLocaleString()}
            </dd>
          </div>
        </dl>
      </section>)}
      {snapshot.submissions.length ? <details className="delivery-details">
        <summary>Message delivery</summary>
        <ul>{snapshot.submissions.map(submission => <li key={submission.id}>
          <span>{submission.type === "input" ? "Message" : "Entry"}</span>
          <strong>{submission.status === "done" ? "Completed" : submission.status === "unanswered" ? "Not answered" : submission.status === "placed" ? "In progress" : "Queued"}</strong>{submission.status === "unanswered" ? <details>
            <summary>Technical delivery details</summary>
            <p>{submission.reason}</p>
          </details> : null}
        </li>)}
        </ul>
      </details> : null}
    </Tabs.Panel>
  </Tabs.Root>;
}
