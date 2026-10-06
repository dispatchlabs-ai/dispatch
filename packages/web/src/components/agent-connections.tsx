import { CheckCircle2, Link2, Plus, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentConnectionStatus, AgentDefinition } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Modal, Notice, Spinner } from "./ui";
import { ConnectWikiDialog, scopeLabels, useWikiConnections } from "./wiki-connections";

export function AgentConnectionsPanel({ agentId }: { agentId: string }) {
  const { api } = useSession();
  const [connections, setConnections] = useState<AgentConnectionStatus[] | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const result = await api<{ connections: AgentConnectionStatus[] }>(`/api/agents/${encodeURIComponent(agentId)}/connections`, undefined, controller.signal);
        if (!controller.signal.aborted) { setConnections(result.connections); setError(""); }
      } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 15_000);
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, agentId, attempt]);

  return <section className="agent-connections" aria-labelledby={`connections-${agentId}`}>
    <h2 id={`connections-${agentId}`}>Connections</h2>
    {error ? <Notice tone="error">Connection status is unavailable. {error} <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Retry</Button></Notice> : null}
    {!connections && !error ? <p className="connection-loading"><Spinner /> Loading connections…</p> : null}
    {connections?.length === 0 ? <p className="connection-empty">No connections configured.</p> : null}
    {connections?.map(connection => <ConnectionCard key={connection.id} connection={connection} stale={Boolean(error)} busy={busy === connection.id} onReconnect={() => {
      setBusy(connection.id);
      void api<{ connections: AgentConnectionStatus[] }>(`/api/agents/${encodeURIComponent(agentId)}/connections/${encodeURIComponent(connection.id)}/reconnect`, {})
        .then(result => { setConnections(result.connections); setError(""); })
        .catch(error => setError(errorMessage(error))).finally(() => setBusy(null));
    }} />)}
  </section>;
}

const toolLabels: Record<string, string> = { "wiki.read": "Read a page", "wiki.search": "Search the Wiki", "wiki.save": "Save a page", "wiki.history": "Page history", "wiki.traceSearch": "Search original evidence", "wiki.trace": "Read original evidence", "wiki.traces": "List original evidence", "wiki.file": "Read an attached file", "wiki.preview": "Preview a page" };

export function ConnectionCard({ connection, stale = false, busy = false, pending = false, onReconnect, onRemove }: { connection: AgentConnectionStatus; stale?: boolean; busy?: boolean; pending?: boolean; onReconnect?: () => void; onRemove?: () => void }) {
  const connected = connection.status === "connected" && !stale;
  return <article className="connection-card">
    <div className="connection-heading">
      <div className="connection-name"><Link2 aria-hidden="true" /><h3>{connection.name}</h3></div>
      <span className={connected ? "connection-status connected" : "connection-status"}>
        {connected ? <CheckCircle2 aria-hidden="true" /> : null}{stale ? "Status unavailable" : connected ? "Connected" : "Not connected"}
      </span>
    </div>
    <p className="connection-endpoint">{connection.endpoint}</p>
    {pending ? <p className="pending-connection">Pending addition · Save to apply</p> : null}
    <dl className="connection-facts">
      <div><dt>Permissions</dt><dd>{connection.scopes?.map(scope => scopeLabels[scope]).join(" · ") || (connection.checkedAt ? connection.access : "Not discovered yet")}</dd></div>
      <div><dt>Wiki identity</dt><dd>{connection.identity || "Available after authorization"}</dd></div>
    </dl>
    {connection.error && !stale ? <Notice tone="error">{connection.error}</Notice> : null}
    {connection.checkedAt ? <details className="connection-tools">
      <summary>{connection.tools.length} available tools</summary>
      <table><thead><tr><th scope="col">Tool</th><th scope="col">Identifier</th></tr></thead><tbody>{connection.tools.map(tool => <tr key={tool.name}><td>{toolLabels[tool.name] || tool.description || tool.name}</td><td><code>{tool.name}</code></td></tr>)}</tbody></table>
      <p>Discovered {new Date(connection.checkedAt).toLocaleString()}.</p>
      {connection.source === "oauth" ? <p>Wiki grants still determine which operations are allowed.</p> : null}
    </details> : null}
    <div className="connection-card-actions">
      {connection.source !== "oauth" ? <span className="field-hint">Managed by your operator</span> : null}
      {!connected && onReconnect ? <Button variant="secondary" disabled={busy} onClick={onReconnect}>{busy ? <Spinner /> : <RefreshCw />} Reconnect</Button> : null}
      {onRemove ? <Button variant="ghost" disabled={busy} onClick={onRemove}>Remove from agent</Button> : null}
    </div>
  </article>;
}

export function AgentConnectionsEditor({ agent, selectedIds, onChange, applyExisting, onApplyExisting, busy, onSettings }: {
  agent?: AgentDefinition; selectedIds: string[]; onChange: (ids: string[]) => void;
  applyExisting: boolean; onApplyExisting: (value: boolean) => void; busy: boolean; onSettings: () => void;
}) {
  const { api } = useSession();
  const { connections, error, refresh } = useWikiConnections();
  const [operator, setOperator] = useState<AgentConnectionStatus[]>([]);
  const [operatorError, setOperatorError] = useState("");
  const [operatorAttempt, setOperatorAttempt] = useState(0);
  const [choosing, setChoosing] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const savedIds = agent?.connections?.filter(connection => connection.source === "oauth").map(connection => connection.id) ?? [];
  const changed = JSON.stringify([...savedIds].sort()) !== JSON.stringify([...selectedIds].sort());
  useEffect(() => {
    if (!agent) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const result = await api<{ connections: AgentConnectionStatus[] }>(`/api/agents/${encodeURIComponent(agent.id)}/connections`, undefined, controller.signal);
        if (!controller.signal.aborted) { setOperator(result.connections.filter(connection => connection.source !== "oauth")); setOperatorError(""); }
      } catch (error) { if (!controller.signal.aborted) setOperatorError(errorMessage(error)); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void load(); }, 15_000);
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, agent?.id, operatorAttempt]);
  const available = connections?.filter(connection => connection.canManage && connection.authorization === "authorized" && !selectedIds.includes(connection.id) && connection.usedBy.every(owner => owner.id === agent?.id)) ?? [];
  return <section className="agent-connections agent-connections-editor" aria-label="MCP connections">
    <div className="editor-section-heading"><div><h2>MCP connections</h2><p>Give this agent access to the services it needs.</p></div><Button variant="secondary" disabled={busy} onClick={() => setChoosing(true)}><Plus /> Add connection</Button></div>
    <p className="field-hint">Manage authorization in <button className="text-link" type="button" disabled={busy} onClick={onSettings}>Settings → Connections</button>. Your draft stays here.</p>
    {error || operatorError ? <Notice>{error || operatorError}<Button variant="ghost" onClick={() => { refresh(); setOperatorAttempt(value => value + 1); }}>Refresh</Button></Notice> : null}
    {operator.map(connection => <ConnectionCard key={connection.id} connection={connection} stale={Boolean(operatorError)} />)}
    {selectedIds.map(id => {
      const connection = connections?.find(connection => connection.id === id);
      const saved = agent?.connections?.find(connection => connection.id === id);
      return connection ? <ConnectionCard key={id} connection={connection} stale={Boolean(error)} busy={busy} pending={!savedIds.includes(id)} onRemove={() => onChange(selectedIds.filter(value => value !== id))} /> : <div key={id} className="connection-card"><p>{saved?.name || "Loading connection…"}</p><Button variant="ghost" disabled={busy} onClick={() => onChange(selectedIds.filter(value => value !== id))}>Remove from agent</Button></div>;
    })}
    {!operator.length && !selectedIds.length && !operatorError ? <p className="connection-empty">No connections added.</p> : null}
    {savedIds.filter(id => !selectedIds.includes(id)).map(id => <div className="connection-removal" key={id}><span>{agent?.connections?.find(connection => connection.id === id)?.name} · Pending removal</span><Button variant="ghost" disabled={busy} onClick={() => onChange([...selectedIds, id])}>Undo</Button></div>)}
    {changed ? <fieldset className="connection-application" disabled={busy}><legend>Apply connection changes</legend>
      <label className="choice-row"><input type="radio" name="connection-application" checked={!applyExisting} onChange={() => onApplyExisting(false)} /><span>New agent instances only<small>Existing conversations keep their current connections.</small></span></label>
      {agent ? <label className="choice-row"><input type="radio" name="connection-application" checked={applyExisting} onChange={() => onApplyExisting(true)} /><span>New and existing instances<small>Update connections in this agent's existing conversations. Other settings stay at their saved revision.</small></span></label> : null}
      <p className="field-hint">This shared agent uses the Wiki identity's standing access. People in its conversations can receive Wiki content, and teammates can edit its instructions.</p>
    </fieldset> : null}
    {choosing ? <Modal title="Add a Wiki connection" description="Choose an authorization for this agent. Each connection is reserved for one agent definition; its instances share the existing Wiki identity." open onOpenChange={setChoosing}>
      <div className="connection-picker">{available.map(connection => <Button variant="secondary" key={connection.id} onClick={() => { onChange([...selectedIds, connection.id]); setChoosing(false); }}>{connection.name} · {connection.identity}</Button>)}
        {!available.length ? <p>No unused authorized connections are available.</p> : null}
        <Notice tone="info">Saving gives this company-shared agent access. Its conversations can share Wiki content with every participant, including people invited later.</Notice>
        <Button onClick={() => { setChoosing(false); setAuthorizing(true); }}><Plus /> Connect another Wiki identity</Button>
      </div>
    </Modal> : null}
    {authorizing ? <ConnectWikiDialog onClose={() => { setAuthorizing(false); refresh(); }} onAuthorized={id => { onChange([...selectedIds, id]); setAuthorizing(false); refresh(); }} /> : null}
  </section>;
}
