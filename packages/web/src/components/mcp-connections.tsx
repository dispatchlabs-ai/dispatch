import { Link2, Plus, RefreshCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConnectMcpInput, ConnectMcpResult, ConnectionAuthentication, ManagedConnection } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, IconButton, Input, Modal, Notice, Select, Spinner } from "./ui";

export const authenticationLabels: Record<ConnectionAuthentication, string> = {
  oauth: "OAuth", bearer: "Bearer token", headers: "Custom headers", none: "No authentication",
};
type ConnectionSettings = ConnectMcpInput extends infer Input ? Input extends ConnectMcpInput ? Omit<Input, "requestId"> : never : never;

export function useMcpConnections() {
  const { api } = useSession();
  const [connections, setConnections] = useState<ManagedConnection[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      clearTimeout(timer);
      try {
        const result = await api<{ connections: ManagedConnection[] }>("/api/connections", undefined, controller.signal);
        if (!controller.signal.aborted) { setConnections(result.connections); setError(""); }
      } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 10_000);
    };
    const message = (event: MessageEvent) => {
      if (event.origin === location.origin && event.data?.type === "dispatch-mcp-authorized") setAttempt(value => value + 1);
    };
    void refresh();
    window.addEventListener("message", message);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener("message", message); };
  }, [api, attempt]);
  return { connections, error, refresh: () => setAttempt(value => value + 1) };
}

export function ConnectMcpDialog({ connection, onClose, onConnected }: {
  connection?: ManagedConnection; onClose: () => void; onConnected: (id: string) => void;
}) {
  const { api } = useSession();
  const { connections, refresh } = useMcpConnections();
  const [name, setName] = useState(connection?.name ?? "");
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? "");
  const [authentication, setAuthentication] = useState<ConnectionAuthentication>(connection?.authentication ?? "oauth");
  const [scopes, setScopes] = useState(connection?.scopes?.join(" ") ?? "");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState([{ id: crypto.randomUUID(), name: "", value: "" }]);
  const [pending, setPending] = useState<ConnectMcpResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<ConnectMcpInput | null>(null);
  const finished = useRef(false);
  const current = connections?.find(item => item.id === pending?.id);
  useEffect(() => {
    if (pending && current?.authorization === "authorized" && !finished.current) {
      finished.current = true;
      onConnected(pending.id);
    }
  }, [pending, current?.authorization, onConnected]);
  return <Modal title={connection ? "Update MCP connection" : "Connect an MCP server"}
    description="Add the server's address and the authentication method it supports. Dispatch discovers its available tools."
    open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <form className="connection-dialog-form" onSubmit={event => {
      event.preventDefault(); event.stopPropagation();
      const base = { name, endpoint, ...(connection ? { connectionId: connection.id } : {}) };
      let settings: ConnectionSettings;
      if (authentication === "oauth") settings = { ...base, authentication,
        ...(scopes.trim() ? { scopes: [...new Set(scopes.trim().split(/\s+/))] } : {}),
        ...(clientId.trim() ? { clientId: clientId.trim() } : {}), ...(clientSecret ? { clientSecret } : {}) };
      else if (authentication === "bearer") settings = { ...base, authentication, token };
      else if (authentication === "headers") {
        const names = headers.map(header => header.name.trim().toLowerCase());
        if (new Set(names).size !== names.length) { setError("Use each header name only once."); return; }
        settings = { ...base, authentication, headers: Object.fromEntries(headers.map(header => [header.name.trim(), header.value])) };
      } else settings = { ...base, authentication };
      const previous = request.current;
      if (!previous || JSON.stringify({ ...previous, requestId: undefined }) !== JSON.stringify(settings)) request.current = { ...settings, requestId: crypto.randomUUID() } as ConnectMcpInput;
      const popup = authentication === "oauth" ? window.open("about:blank", "dispatch-mcp-authorization", "popup,width=680,height=800") : null;
      setBusy(true); setError("");
      void api<ConnectMcpResult>("/api/connections/authorize", request.current)
        .then(result => {
          refresh();
          if (result.authorizationUrl) { setPending(result); if (popup) popup.location.href = result.authorizationUrl; }
          else { popup?.close(); finished.current = true; onConnected(result.id); }
        })
        .catch(error => {
          popup?.close();
          if (error instanceof ApiError && error.status >= 400 && error.status < 500) request.current = null;
          setError(errorMessage(error));
        })
        .finally(() => setBusy(false));
    }}>
      {error ? <Notice>{error}</Notice> : null}
      {pending ? <>
        <Notice tone="info">{current?.error || "Finish authorization in the provider's window. Save your agent definition to apply the connection."}</Notice>
        {pending.authorizationUrl ? <a className="connection-auth-link" href={pending.authorizationUrl} target="dispatch-mcp-authorization" rel="noreferrer">Open authorization</a> : null}
        <div className="button-row"><Button variant="secondary" onClick={onClose}>Close</Button>
          <Button variant="secondary" onClick={refresh}><RefreshCw /> Check authorization</Button>
          <Button onClick={() => { request.current = null; setPending(null); }}>Start again</Button>
        </div>
      </> : <>
        <Field label="Connection name">{props => <Input {...props} value={name} maxLength={100} required disabled={busy || Boolean(connection)} placeholder="e.g. Project files" onChange={event => setName(event.target.value)} />}</Field>
        <Field label="MCP server URL" hint="Use the server's Streamable HTTP endpoint. Keep credentials in the authentication fields below.">{props => <Input {...props} type="url" value={endpoint} required disabled={busy || Boolean(connection)} placeholder="https://service.example.com/mcp" onChange={event => setEndpoint(event.target.value)} />}</Field>
        <Field label="Authentication">{props => <Select {...props} value={authentication} disabled={busy || Boolean(connection)} onChange={event => setAuthentication(event.target.value as ConnectionAuthentication)}>
          {Object.entries(authenticationLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </Select>}</Field>
        {authentication === "oauth" ? <>
          <p className="field-hint">Sign in with the provider in a separate window. Its authorization page controls the account and permissions.</p>
          <details className="connection-advanced"><summary>Advanced OAuth settings</summary>
            <Field label="Scopes" hint="Optional, separated by spaces. Leave blank to use scopes advertised by the server.">{props => <Input {...props} value={scopes} disabled={busy || Boolean(connection)} onChange={event => setScopes(event.target.value)} />}</Field>
            <Field label="Client ID" hint="Only needed when the provider requires a client you registered yourself.">{props => <Input {...props} value={clientId} autoComplete="off" disabled={busy} onChange={event => setClientId(event.target.value)} />}</Field>
            <Field label="Client secret" hint="If required by your registered OAuth client. Stored encrypted by Dispatch.">{props => <Input {...props} type="password" value={clientSecret} autoComplete="new-password" disabled={busy} onChange={event => setClientSecret(event.target.value)} />}</Field>
            <p className="field-hint">Callback URL: <code>{location.origin}/api/connections/oauth/callback</code></p>
          </details>
        </> : authentication === "bearer" ? <Field label="Bearer token" hint="Paste the token issued for this MCP server. Stored encrypted by Dispatch.">{props => <Input {...props} type="password" value={token} autoComplete="new-password" required disabled={busy} onChange={event => setToken(event.target.value)} />}</Field>
          : authentication === "headers" ? <fieldset className="connection-header-fields" disabled={busy}><legend>Authentication headers</legend>
            <p className="field-hint">Use the provider's header name and secret value, such as an API key. Values are stored encrypted.</p>
            {headers.map((header, index) => <div className="connection-header-row" key={header.id}>
              <Field label={`Header ${index + 1} name`}>{props => <Input {...props} required value={header.name} autoComplete="off" placeholder="e.g. X-API-Key" onChange={event => setHeaders(rows => rows.map(row => row.id === header.id ? { ...row, name: event.target.value } : row))} />}</Field>
              <Field label={`Header ${index + 1} value`}>{props => <Input {...props} required type="password" value={header.value} autoComplete="new-password" onChange={event => setHeaders(rows => rows.map(row => row.id === header.id ? { ...row, value: event.target.value } : row))} />}</Field>
              <IconButton label={`Remove header ${index + 1}`} disabled={headers.length === 1} onClick={() => setHeaders(rows => rows.filter(row => row.id !== header.id))}><X /></IconButton>
            </div>)}
            <Button variant="secondary" onClick={() => setHeaders(rows => [...rows, { id: crypto.randomUUID(), name: "", value: "" }])}><Plus /> Add header</Button>
          </fieldset> : <p className="field-hint">Connect without sending credentials. The server determines which tools are available.</p>}
        <div className="button-row"><Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? <Spinner /> : <Link2 />}{authentication === "oauth" ? "Authorize" : "Connect"}</Button></div>
      </>}
    </form>
  </Modal>;
}

const authorizationLabels = { pending: "Awaiting authorization", authorized: "Configured", reauthorize: "Action needed", revoking: "Revocation pending", revoked: "Disconnected", error: "Authorization failed" };

export function McpConnectionsPage() {
  const { api } = useSession();
  const { connections, error: loadError, refresh } = useMcpConnections();
  const [dialog, setDialog] = useState<ManagedConnection | "new" | null>(null);
  const [disconnect, setDisconnect] = useState<ManagedConnection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  function action(id: string, name: "disconnect" | "reconnect") {
    setBusy(id); setError("");
    void api(`/api/connections/${encodeURIComponent(id)}/${name}`, {})
      .then(() => setDisconnect(null)).catch(error => setError(errorMessage(error)))
      .finally(() => { setBusy(null); refresh(); });
  }
  return <section className="agent-view connections-page">
    <header className="view-heading"><div><p className="page-eyebrow">Settings</p><h1>Connections</h1><p>Manage MCP servers, authentication, and the agents that use them.</p></div><Button onClick={() => setDialog("new")}><Plus /> Connect server</Button></header>
    <div className="agent-content"><div className="connections-page-inner">
      {error || loadError ? <Notice>{error || loadError}<Button variant="ghost" onClick={refresh}>Refresh</Button></Notice> : null}
      {!connections && !loadError ? <p><Spinner /> Loading connections…</p> : null}
      {connections?.length === 0 ? <div className="connections-empty"><Link2 /><h2>No MCP connections added here</h2><p>Connect a server, then choose it in an agent definition. Operator-managed connections remain on their agent definitions.</p></div> : null}
      {connections?.map(connection => <article className="connection-card" key={connection.id}>
        <div className="connection-heading"><div className="connection-name"><Link2 /><h2>{connection.name}</h2></div><span className="revision-badge">{authorizationLabels[connection.authorization ?? "pending"]}</span></div>
        <p className="connection-endpoint">{connection.endpoint}</p>
        <dl className="connection-facts">
          <div><dt>Authentication</dt><dd>{authenticationLabels[connection.authentication ?? "oauth"]}</dd></div>
          <div><dt>Server status</dt><dd>{loadError ? "Unavailable" : connection.status === "connected" ? "Connected" : "Not connected"}</dd></div>
          {connection.serverName ? <div><dt>Server</dt><dd>{connection.serverName}</dd></div> : null}
          {connection.identity ? <div><dt>Identity</dt><dd>{connection.identity}</dd></div> : null}
          {connection.scopes?.length ? <div><dt>{connection.authorization === "pending" ? "Requested scopes" : "Authorized scopes"}</dt><dd>{connection.scopes.join(" · ")}</dd></div> : null}
          <div><dt>Agent definition</dt><dd>{connection.usedBy.map(agent => agent.name).join(", ") || "Not assigned"}</dd></div>
        </dl>
        {connection.error ? <Notice>{connection.error}</Notice> : null}
        {connection.disconnectNotice ? <p className="field-hint">{connection.disconnectNotice}</p> : null}
        {connection.canManage ? <div className="button-row">
          {connection.authorization === "authorized" ? <Button variant="secondary" disabled={busy === connection.id} onClick={() => action(connection.id, "reconnect")}>{busy === connection.id ? <Spinner /> : <RefreshCw />} Refresh status</Button> : null}
          {connection.authorization !== "revoking" && (connection.authorization !== "authorized" || connection.authentication === "bearer" || connection.authentication === "headers") ? <Button variant="secondary" disabled={busy === connection.id} onClick={() => setDialog(connection)}>{connection.authentication === "oauth" ? "Authorize" : "Update connection"}</Button> : null}
          {connection.authorization !== "revoked" ? <Button variant="ghost" disabled={busy === connection.id} onClick={() => setDisconnect(connection)}>{connection.authorization === "revoking" ? "Retry disconnect" : "Disconnect"}</Button> : null}
        </div> : <p className="field-hint">Managed by the teammate who connected this server.</p>}
      </article>)}
    </div></div>
    {dialog ? <ConnectMcpDialog connection={dialog === "new" ? undefined : dialog} onClose={() => { setDialog(null); refresh(); }} onConnected={() => { setDialog(null); refresh(); }} /> : null}
    {disconnect ? <Modal title={`Disconnect ${disconnect.name}?`} description="This disables future access through Dispatch for every agent instance using the connection. OAuth grants are revoked when the provider supports it; other credentials must be revoked with the provider. Saved conversation content remains available." open onOpenChange={open => { if (!open && !busy) setDisconnect(null); }}>
      {error ? <Notice>{error}</Notice> : null}<div className="button-row"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => setDisconnect(null)}>Keep connected</Button><Button variant="danger" disabled={Boolean(busy)} onClick={() => action(disconnect.id, "disconnect")}>{busy ? <Spinner /> : null} Disconnect</Button></div>
    </Modal> : null}
  </section>;
}
