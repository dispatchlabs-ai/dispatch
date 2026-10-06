import { Link2, Plus, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConnectWikiInput, WikiConnection, WikiScope } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Modal, Notice, Spinner } from "./ui";

export const scopeLabels: Record<WikiScope, string> = {
  "wiki:read": "Read articles", "wiki:write": "Edit articles", "wiki:trace": "Read original evidence",
};

export function useWikiConnections() {
  const { api } = useSession();
  const [connections, setConnections] = useState<WikiConnection[] | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      clearTimeout(timer);
      try {
        const result = await api<{ connections: WikiConnection[] }>("/api/connections", undefined, controller.signal);
        if (!controller.signal.aborted) { setConnections(result.connections); setError(""); }
      } catch (error) { if (!controller.signal.aborted) setError(errorMessage(error)); }
      if (!controller.signal.aborted) timer = setTimeout(() => { void refresh(); }, 10_000);
    };
    const message = (event: MessageEvent) => {
      if (event.origin === location.origin && event.data?.type === "dispatch-wiki-authorized") setAttempt(value => value + 1);
    };
    void refresh();
    window.addEventListener("message", message);
    return () => { controller.abort(); clearTimeout(timer); window.removeEventListener("message", message); };
  }, [api, attempt]);
  return { connections, error, refresh: () => setAttempt(value => value + 1) };
}

export function ConnectWikiDialog({ connection, onClose, onAuthorized }: {
  connection?: WikiConnection; onClose: () => void; onAuthorized: (id: string) => void;
}) {
  const { api } = useSession();
  const { connections, refresh } = useWikiConnections();
  const [name, setName] = useState(connection?.name ?? "Wiki");
  const [endpoint, setEndpoint] = useState(connection?.endpoint ?? "");
  const [scopes, setScopes] = useState<WikiScope[]>(connection?.scopes ?? ["wiki:read"]);
  const [pending, setPending] = useState<{ id: string; authorizationUrl: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const request = useRef<ConnectWikiInput | null>(null);
  const finished = useRef(false);
  const current = connections?.find(item => item.id === pending?.id);
  useEffect(() => {
    if (pending && current?.authorization === "authorized" && !finished.current) {
      finished.current = true;
      onAuthorized(pending.id);
    }
  }, [pending, current?.authorization, onAuthorized]);
  return <Modal title={connection ? "Authorize Wiki again" : "Connect a Wiki"}
    description="Sign in to your Wiki and choose an existing Wiki agent. Its identity and permissions will appear here after authorization."
    open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <form className="connection-dialog-form" onSubmit={event => {
      event.preventDefault();
      event.stopPropagation();
      const popup = window.open("about:blank", "dispatch-wiki-authorization", "popup,width=680,height=800");
      const input = { name, endpoint, scopes, ...(connection ? { connectionId: connection.id } : {}) };
      const previous = request.current;
      if (!previous || JSON.stringify({ ...previous, requestId: undefined }) !== JSON.stringify(input)) request.current = { ...input, requestId: crypto.randomUUID() };
      setBusy(true); setError("");
      void api<{ id: string; authorizationUrl: string }>("/api/connections/authorize", request.current)
        .then(result => { setPending(result); refresh(); if (popup) popup.location.href = result.authorizationUrl; })
        .catch(error => { popup?.close(); setError(errorMessage(error)); request.current = null; })
        .finally(() => setBusy(false));
    }}>
      {error ? <Notice>{error}</Notice> : null}
      {pending ? <>
        <Notice tone="info">{current?.error || "Finish authorization in the Wiki window. This connection will not be added to an agent until you save its definition."}</Notice>
        <a className="connection-auth-link" href={pending.authorizationUrl} target="dispatch-wiki-authorization" rel="noreferrer">Open Wiki authorization</a>
        <div className="button-row">
          <Button variant="secondary" onClick={onClose}>Close</Button>
          {current?.authorization === "error" || current?.authorization === "reauthorize" ? <Button onClick={() => { request.current = null; setPending(null); }}>Start again</Button> : <Button variant="secondary" onClick={refresh}><RefreshCw /> Check authorization</Button>}
        </div>
      </> : <>
        <Field label="Connection name">{props => <Input {...props} value={name} maxLength={100} required disabled={busy || Boolean(connection)} onChange={event => setName(event.target.value)} />}</Field>
        <Field label="Wiki MCP address" hint="The HTTPS address ending in /mcp.">{props => <Input {...props} type="url" value={endpoint} required placeholder="https://wiki.example.com/mcp" disabled={busy || Boolean(connection)} onChange={event => setEndpoint(event.target.value)} />}</Field>
        <fieldset className="connection-permissions" disabled={busy || Boolean(connection)}><legend>Permitted actions</legend>
          {(Object.keys(scopeLabels) as WikiScope[]).map(scope => <label className="choice-row" key={scope}>
            <input type="checkbox" checked={scopes.includes(scope)} disabled={scope === "wiki:read"} onChange={event => setScopes(current => event.target.checked ? [...current, scope] : current.filter(value => value !== scope))} />
            <span>{scopeLabels[scope]}{scope === "wiki:read" ? <small>Required</small> : null}</span>
          </label>)}
        </fieldset>
        <p className="field-hint">The Wiki agent's existing grants also limit access. Connecting does not create or register a Wiki agent.</p>
        <div className="button-row"><Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button type="submit" disabled={busy}>{busy ? <Spinner /> : <Link2 />} Continue to Wiki</Button></div>
      </>}
    </form>
  </Modal>;
}

const authorizationLabels = { pending: "Awaiting authorization", authorized: "Authorized", reauthorize: "Authorization needed", revoking: "Revocation pending", revoked: "Disconnected", error: "Authorization failed" };

export function WikiConnectionsPage() {
  const { api } = useSession();
  const { connections, error: loadError, refresh } = useWikiConnections();
  const [dialog, setDialog] = useState<WikiConnection | "new" | null>(null);
  const [disconnect, setDisconnect] = useState<WikiConnection | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState("");
  function action(id: string, name: "disconnect" | "reconnect") {
    setBusy(id); setError("");
    void api(`/api/connections/${encodeURIComponent(id)}/${name}`, {})
      .then(() => setDisconnect(null)).catch(error => setError(errorMessage(error)))
      .finally(() => { setBusy(null); refresh(); });
  }
  return <section className="agent-view connections-page">
    <header className="view-heading"><div><p className="page-eyebrow">Settings</p><h1>Connections</h1><p>Manage Wiki authorizations and where they are used.</p></div><Button onClick={() => setDialog("new")}><Plus /> Connect Wiki</Button></header>
    <div className="agent-content"><div className="connections-page-inner">
      {error || loadError ? <Notice>{error || loadError}<Button variant="ghost" onClick={refresh}>Refresh</Button></Notice> : null}
      {!connections && !loadError ? <p><Spinner /> Loading connections…</p> : null}
      {connections?.length === 0 ? <div className="connections-empty"><Link2 /><h2>No Wiki authorizations added here</h2><p>Authorize an existing Wiki agent, then add the connection to a Dispatch agent definition. Operator-managed connections remain on their agent definitions.</p></div> : null}
      {connections?.map(connection => <article className="connection-card" key={connection.id}>
        <div className="connection-heading"><div className="connection-name"><Link2 /><h2>{connection.name}</h2></div><span className="revision-badge">{authorizationLabels[connection.authorization ?? "pending"]}</span></div>
        <p className="connection-endpoint">{connection.endpoint}</p>
        <dl className="connection-facts"><div><dt>Wiki identity</dt><dd>{connection.identity || "Available after authorization"}</dd></div><div><dt>Permissions</dt><dd>{connection.scopes?.map(scope => scopeLabels[scope]).join(" · ")}</dd></div><div><dt>Agent definition</dt><dd>{connection.usedBy.map(agent => agent.name).join(", ") || "Not assigned"}</dd></div></dl>
        {connection.error ? <Notice>{connection.error}</Notice> : null}
        {connection.canManage ? <div className="button-row">
          {connection.authorization === "authorized" ? <Button variant="secondary" disabled={busy === connection.id} onClick={() => action(connection.id, "reconnect")}>{busy === connection.id ? <Spinner /> : <RefreshCw />} Refresh status</Button> : connection.authorization !== "revoking" ? <Button variant="secondary" onClick={() => setDialog(connection)}>Authorize{connection.authorization === "pending" ? "" : " again"}</Button> : null}
          {connection.authorization !== "revoked" ? <Button variant="ghost" disabled={busy === connection.id} onClick={() => setDisconnect(connection)}>{connection.authorization === "revoking" ? "Retry disconnect" : "Disconnect"}</Button> : null}
        </div> : <p className="field-hint">Managed by the teammate who authorized this connection.</p>}
      </article>)}
    </div></div>
    {dialog ? <ConnectWikiDialog connection={dialog === "new" ? undefined : dialog} onClose={() => { setDialog(null); refresh(); }} onAuthorized={() => { setDialog(null); refresh(); }} /> : null}
    {disconnect ? <Modal title={`Disconnect ${disconnect.name}?`} description="This immediately disables the connection in Dispatch for every agent instance using it, then revokes its Wiki authorization. Saved conversation content remains available." open onOpenChange={open => { if (!open && !busy) setDisconnect(null); }}>
      {error ? <Notice>{error}</Notice> : null}<div className="button-row"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => setDisconnect(null)}>Keep connected</Button><Button variant="danger" disabled={Boolean(busy)} onClick={() => action(disconnect.id, "disconnect")}>{busy ? <Spinner /> : null} Disconnect</Button></div>
    </Modal> : null}
  </section>;
}
