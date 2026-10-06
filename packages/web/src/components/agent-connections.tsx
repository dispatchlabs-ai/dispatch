import { CheckCircle2, Link2, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import type { AgentConnectionStatus } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Notice, Spinner } from "./ui";

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

export function ConnectionCard({ connection, stale = false, busy = false, onReconnect }: { connection: AgentConnectionStatus; stale?: boolean; busy?: boolean; onReconnect: () => void }) {
  const connected = connection.status === "connected" && !stale;
  return <article className="connection-card">
    <div className="connection-heading">
      <div className="connection-name"><Link2 aria-hidden="true" /><h3>{connection.name}</h3></div>
      <span className={connected ? "connection-status connected" : "connection-status"}>
        {connected ? <CheckCircle2 aria-hidden="true" /> : null}{stale ? "Status unavailable" : connected ? "Connected" : "Not connected"}
      </span>
    </div>
    <p className="connection-endpoint">{connection.endpoint}</p>
    <dl className="connection-facts">
      <div><dt>Access</dt><dd>{connection.checkedAt ? connection.access : "Not discovered yet"}</dd></div>
      <div><dt>Identity</dt><dd>{connection.identity}</dd></div>
    </dl>
    {connection.error && !stale ? <Notice tone="error">{connection.error}</Notice> : null}
    {connection.checkedAt ? <details className="connection-tools">
      <summary>{connection.tools.length} available tools</summary>
      <ul>{connection.tools.map(tool => <li key={tool.name}><code>{tool.name}</code></li>)}</ul>
      <p>Discovered {new Date(connection.checkedAt).toLocaleString()}.</p>
    </details> : null}
    {!connected ? <Button variant="secondary" disabled={busy} onClick={onReconnect}>{busy ? <Spinner /> : <RefreshCw />} Reconnect</Button> : null}
  </article>;
}
