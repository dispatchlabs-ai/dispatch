import { useEffect, useState } from "react";
import type { AgentDefinition } from "../shared/contracts";
import type { SearchSecret } from "../shared/secrets";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Notice, Select, Spinner } from "./ui";

export function SecretsPage() {
  const { api } = useSession();
  const [saved, setSaved] = useState<SearchSecret | null>(null);
  const [agents, setAgents] = useState<AgentDefinition[]>([]);
  const [source, setSource] = useState<"stored" | "environment">("stored");
  const [value, setValue] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [attempt, setAttempt] = useState(0);
  function accept(secret: SearchSecret) {
    setSaved(secret); setSource(secret.source === "environment" ? "environment" : "stored");
    setAgentIds(secret.agentIds); setValue("");
  }
  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([api<SearchSecret>("/api/secrets/exa", undefined, controller.signal), api<{ agents: AgentDefinition[] }>("/api/agents", undefined, controller.signal)])
      .then(([secret, result]) => { if (!controller.signal.aborted) { accept(secret); setAgents(result.agents.filter(agent => !agent.archived)); setError(""); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, attempt]);
  async function save(disconnect = false) {
    setBusy(true); setError(""); setMessage("");
    try {
      const secret = await api<SearchSecret>(disconnect ? "/api/secrets/exa/disconnect" : "/api/secrets/exa", disconnect ? { revision: saved!.revision } : { revision: saved!.revision, source, ...(source === "stored" && value.trim() ? { value: value.trim() } : {}), agentIds });
      accept(secret); setMessage(disconnect ? "Disconnected locally. Revoke the key with Exa if needed." : "Saved.");
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <section className="agent-view connections-page">
    <header className="view-heading"><h1>Secrets</h1></header>
    <div className="agent-content"><div className="connections-page-inner">
      {error ? <Notice>{error}<Button variant="ghost" disabled={busy} onClick={() => { if (!saved || window.confirm("Reload saved settings and discard this draft?")) setAttempt(n => n + 1); }}>Reload settings</Button></Notice> : null}
      {!saved && !error ? <p><Spinner /> Loading secrets…</p> : null}
      {saved ? <form className="connection-card" onSubmit={event => { event.preventDefault(); void save(); }}>
        <div className="connection-heading"><h2>Exa search</h2><span className="revision-badge">{saved.status === "configured" ? "Configured · not verified" : saved.status === "missing" ? "Environment key missing" : "Not configured"}</span></div>
        <Field label="Credential source">{props => <Select {...props} value={source} disabled={busy} onChange={event => setSource(event.target.value as typeof source)}><option value="stored">Encrypted storage</option><option value="environment">Server environment · EXA_API_KEY</option></Select>}</Field>
        {source === "stored" ? <Field label={saved.source === "stored" ? "Replace API key" : "API key"} hint={saved.source === "stored" ? "Leave blank to keep the saved key." : undefined}>{props => <Input {...props} type="password" autoComplete="new-password" value={value} disabled={busy} onChange={event => setValue(event.target.value)} />}</Field> : null}
        <fieldset disabled={busy}><legend>Allow agents to use this key</legend>
          <p className="field-hint">Applies to existing and future instances. Results are shared with conversation participants.</p>
          {agents.map(agent => <label className="checkbox-field" key={agent.id}><input type="checkbox" checked={agentIds.includes(agent.id)} onChange={event => setAgentIds(ids => event.target.checked ? [...ids, agent.id] : ids.filter(id => id !== agent.id))} />{agent.name}{!agent.capabilities?.includes("web-research") ? " (Web research disabled)" : ""}</label>)}
        </fieldset>
        {message ? <p role="status">{message}</p> : null}
        <div className="button-row"><Button type="submit" disabled={busy}>{busy ? <Spinner /> : null}Save changes</Button><Button type="button" variant="ghost" disabled={busy || saved.source === "disconnected"} onClick={() => { if (window.confirm("Disconnect Exa for all assigned agents?")) void save(true); }}>Disconnect</Button></div>
      </form> : null}
    </div></div>
  </section>;
}
