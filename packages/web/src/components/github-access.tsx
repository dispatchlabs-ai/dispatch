import { useEffect, useRef, useState } from "react";
import type { AgentDefinition } from "../shared/contracts";
import type { GitHubAccount, GitHubConnection, GitHubRepository, GitHubRepositoryBinding } from "../shared/github-access";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Modal, Notice, Select, Spinner } from "./ui";
import "./github-access.css";

type Status = { configured: boolean; canManage: boolean; connections: GitHubConnection[]; repositories: GitHubRepositoryBinding[] };

function useGitHub(projectId?: string) {
  const { api } = useSession();
  const [status, setStatus] = useState<Status>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const receipt = useRef<{ fingerprint: string; requestId: string } | null>(null);
  const endpoint = projectId ? `/api/projects/${encodeURIComponent(projectId)}/github` : "/api/github";
  useEffect(() => {
    const controller = new AbortController();
    void api<Status>(endpoint, undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) { setStatus(result); setError(""); }
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, endpoint, attempt]);
  async function save(input: Record<string, unknown>) {
    const fingerprint = JSON.stringify(input);
    if (receipt.current?.fingerprint !== fingerprint) receipt.current = { fingerprint, requestId: crypto.randomUUID() };
    setBusy(true); setError("");
    try {
      await api("/api/github/access", { ...input, requestId: receipt.current.requestId });
      setStatus(await api<Status>(endpoint));
      receipt.current = null;
      return true;
    } catch (error) {
      setError(errorMessage(error));
      if (error instanceof ApiError && error.status === 409) {
        try { setStatus(await api<Status>(endpoint)); } catch { /* Preserve the prior display and explicit conflict. */ }
      }
      return false;
    } finally { setBusy(false); }
  }
  return { api, status, error, busy, save, reload: () => setAttempt(value => value + 1) };
}

export function GitHubPage() {
  const { api, status, error, busy, save, reload } = useGitHub();
  const [accounts, setAccounts] = useState<GitHubAccount[]>();
  const [accountError, setAccountError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [disconnect, setDisconnect] = useState<GitHubConnection>();
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!status?.canManage || !status.configured) return;
    const controller = new AbortController();
    void api<{ accounts: GitHubAccount[] }>("/api/github/accounts", undefined, controller.signal).then(result => {
      if (!controller.signal.aborted) { setAccounts(result.accounts); setAccountError(""); }
    }).catch(error => { if (!controller.signal.aborted) setAccountError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, status?.canManage, status?.configured, attempt]);
  const shown = accounts ?? status?.connections ?? [];
  return <section className="agent-view connections-page github-access">
    <header className="view-heading"><h1>GitHub</h1></header>
    <div className="agent-content"><div className="connections-page-inner stack">
      <p>Connect your organization’s GitHub App, then choose repositories and agent access in each project’s settings.</p>
      {error ? <Notice>{error}<Button variant="ghost" onClick={reload} disabled={busy}>Reload saved connections</Button></Notice> : null}
      {!status && !error ? <Spinner label="Loading GitHub connections" /> : null}
      {status && !status.configured ? <Notice tone="info">GitHub access has not been configured for this deployment. An operator must connect its GitHub credential service.</Notice> : null}
      {status?.configured && !status.canManage ? <Notice tone="info">A configured administrator manages company connections. Project managers choose repositories and agent permissions.</Notice> : null}
      {accountError ? <Notice>{accountError}<Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Check installations again</Button></Notice> : null}
      {status?.canManage && !accounts && !accountError ? <Spinner label="Checking installed GitHub Apps" /> : null}
      {shown.map(account => {
        const saved = status?.connections.find(connection => connection.id === account.id);
        return <article className="connection-card" key={account.id}>
          <div className="connection-heading"><h2>{account.login}</h2><span className="revision-badge">{saved?.connected ? "Connected" : saved ? "Disconnected" : "Installed"}</span></div>
          <p><a href={account.appUrl} target="_blank" rel="noreferrer">{account.appName}</a> · {account.canWrite ? "Read and write available" : "Read available"}</p>
          <p className="field-hint">Commits use {account.bot.login}. Connecting does not grant repository access to agents.</p>
          <div className="button-row">
            {status?.canManage ? saved?.connected
              ? <Button variant="secondary" disabled={busy} onClick={() => setDisconnect(saved)}>Disconnect</Button>
              : <Button disabled={busy || !accounts} onClick={() => void save({ action: "connect", connectionId: account.id, revision: saved?.revision ?? 0 })}>{busy ? <Spinner /> : null}{saved ? "Reconnect" : "Connect"}</Button> : null}
            <a className="button button-ghost" href={account.settingsUrl} target="_blank" rel="noreferrer">Manage on GitHub</a>
          </div>
        </article>;
      })}
      {status?.configured && !shown.length && accounts ? <p>No GitHub installations are configured for this deployment.</p> : null}
    </div></div>
    <Modal title={`Disconnect ${disconnect?.login ?? "GitHub"}?`} open={Boolean(disconnect)} onOpenChange={open => { if (!open && !busy) setDisconnect(undefined); }} initialFocus={cancel}>
      <div className="github-dialog stack"><p>Stop subsequent authenticated Git operations through this connection in every linked project. Existing repository selections and grants are retained; access resumes if you reconnect this installation.</p><p>This does not uninstall the App, remove cloned files or reverse completed pushes.</p>
        {error ? <Notice>{error}</Notice> : null}
        <div className="button-row"><Button ref={cancel} variant="secondary" disabled={busy} onClick={() => setDisconnect(undefined)}>Cancel</Button><Button variant="danger" disabled={busy} onClick={async () => {
          if (disconnect && await save({ action: "disconnect", connectionId: disconnect.id, revision: disconnect.revision })) setDisconnect(undefined);
        }}>{busy ? <Spinner /> : null}Disconnect</Button></div>
      </div>
    </Modal>
  </section>;
}

export function ProjectGitHub({ projectId, agents, editable }: { projectId: string; agents: AgentDefinition[]; editable: boolean }) {
  const { api, status, error, busy, save, reload } = useGitHub(projectId);
  const [connectionId, setConnectionId] = useState("");
  const [available, setAvailable] = useState<GitHubRepository[]>([]);
  const [nextPage, setNextPage] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [remove, setRemove] = useState<GitHubRepositoryBinding>();
  const cancel = useRef<HTMLButtonElement>(null);
  const loadingController = useRef<AbortController | null>(null);
  useEffect(() => () => loadingController.current?.abort(), []);
  async function load(id: string, page = 1) {
    loadingController.current?.abort();
    const controller = new AbortController(); loadingController.current = controller;
    setConnectionId(id); setLoading(true); setLoadError("");
    if (page === 1) { setAvailable([]); setSelected(""); setNextPage(null); }
    try {
      const result = await api<{ repositories: GitHubRepository[]; nextPage: number | null }>(`/api/projects/${projectId}/github/repositories?connectionId=${encodeURIComponent(id)}&page=${page}`, undefined, controller.signal);
      if (!controller.signal.aborted) { setAvailable(prior => page === 1 ? result.repositories : [...prior, ...result.repositories]); setNextPage(result.nextPage); }
    } catch (error) { if (!controller.signal.aborted) setLoadError(errorMessage(error)); }
    finally { if (!controller.signal.aborted) setLoading(false); }
  }
  const connected = status?.connections.filter(connection => connection.connected) ?? [];
  const selectedConnection = connected.find(connection => connection.id === connectionId);
  const candidates = available.filter(repository => !status?.repositories.some(binding => binding.id === repository.id)
    && repository.name.toLowerCase().includes(query.toLowerCase()));
  return <section className="github-access github-project stack">
    <div><h3>GitHub access</h3><p className="field-hint">{editable ? "Repository connections and access changes save separately from the project draft. Discarding project settings does not undo them." : "Repositories explicitly connected to this project."}</p></div>
    {error ? <Notice>{error}<Button variant="ghost" disabled={busy} onClick={reload}>Reload saved access</Button></Notice> : null}
    {!status && !error ? <Spinner label="Loading repository access" /> : null}
    {status && !status.configured ? <p>GitHub access is not configured. <a href="/?section=github">Open GitHub settings</a></p> : null}
    {status?.repositories.map(binding => <article className="connection-card" key={binding.bindingId}>
      <div className="connection-heading"><h4><a href={binding.url.replace(/\.git$/, "")} target="_blank" rel="noreferrer">{binding.name}</a></h4><span className="revision-badge">{binding.private ? "Private" : "Public"}</span></div>
      {!connected.some(connection => connection.id === binding.connectionId) ? <Notice tone="info">Connection disconnected. Grants are retained but remote Git is unavailable.</Notice> : null}
      {editable ? <>
        <p className="field-hint">Access requires Files and commands on the acting agent instance. Pinned revisions may differ from the latest definition.</p>
        {agents.filter(agent => !agent.archived).map(agent => <RepositoryGrant key={agent.id} binding={binding} agent={agent} disabled={busy} save={save} />)}
        <Button variant="ghost" disabled={busy} onClick={() => setRemove(binding)}>Remove repository</Button>
      </> : <p className="field-hint">{binding.grants.length} agent {binding.grants.length === 1 ? "grant" : "grants"}</p>}
    </article>)}
    {status && !status.repositories.length ? <p className="text-muted">No connected repositories</p> : null}
    {editable && status?.configured ? <div className="connection-card stack">
      <h4>Connect a repository</h4>
      {!connected.length ? <p>Connect an organization in <a href="/?section=github">GitHub settings</a> first.</p> : <>
        <Field label="Organization">{props => <Select {...props} value={connectionId} disabled={busy || loading} onChange={event => { if (event.target.value) void load(event.target.value); else { setConnectionId(""); setAvailable([]); } }}><option value="">Choose an organization</option>{connected.map(connection => <option key={connection.id} value={connection.id}>{connection.login}</option>)}</Select>}</Field>
        {selectedConnection ? <>
          <Field label="Find repository">{props => <Input {...props} value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter loaded repositories" />}</Field>
          <Field label="Repository">{props => <Select {...props} value={selected} disabled={busy || loading} onChange={event => setSelected(event.target.value)}><option value="">Choose a repository</option>{candidates.map(repository => <option key={repository.id} value={repository.id}>{repository.name}{repository.private ? " · Private" : ""}</option>)}</Select>}</Field>
          {loadError ? <Notice>{loadError}<Button variant="ghost" onClick={() => void load(connectionId)}>Retry</Button></Notice> : null}
          {loading ? <Spinner label="Loading repositories" /> : null}
          <div className="button-row">{nextPage ? <Button variant="secondary" disabled={loading || busy} onClick={() => void load(connectionId, nextPage)}>Load more repositories</Button> : null}<Button disabled={busy || loading || !selected} onClick={async () => {
            if (await save({ action: "bind", projectId, connectionId, repositoryId: Number(selected), revision: selectedConnection.revision })) setSelected("");
          }}>{busy ? <Spinner /> : null}Connect repository</Button></div>
        </> : null}
      </>}
    </div> : null}
    <Modal title="Remove repository access?" open={Boolean(remove)} onOpenChange={open => { if (!open && !busy) setRemove(undefined); }} initialFocus={cancel}>
      <div className="github-dialog stack"><p>Remove {remove?.name} from this project and revoke its {remove?.grants.length ?? 0} agent grants. Cloned files remain in existing workspaces.</p>
        {error ? <Notice>{error}</Notice> : null}
        {remove && status?.repositories.find(binding => binding.bindingId === remove.bindingId)?.revision !== remove.revision ? <Notice>Saved access changed. Cancel and review the current grants before removing this repository.</Notice> : null}
        <div className="button-row"><Button ref={cancel} variant="secondary" disabled={busy} onClick={() => setRemove(undefined)}>Cancel</Button><Button variant="danger" disabled={busy || !remove || status?.repositories.find(binding => binding.bindingId === remove.bindingId)?.revision !== remove.revision} onClick={async () => {
          if (remove && await save({ action: "remove", projectId, bindingId: remove.bindingId, revision: remove.revision })) setRemove(undefined);
        }}>{busy ? <Spinner /> : null}Remove and revoke grants</Button></div>
      </div>
    </Modal>
  </section>;
}

function RepositoryGrant({ binding, agent, disabled, save }: { binding: GitHubRepositoryBinding; agent: AgentDefinition; disabled: boolean; save(input: Record<string, unknown>): Promise<boolean> }) {
  const saved = binding.grants.find(grant => grant.definitionId === agent.id)?.permission ?? "none";
  const [permission, setPermission] = useState(saved);
  const [reviewedRevision, setReviewedRevision] = useState(binding.revision);
  const [dirty, setDirty] = useState(false);
  const conflict = dirty && reviewedRevision !== binding.revision;
  useEffect(() => { if (!dirty) { setPermission(saved); setReviewedRevision(binding.revision); } }, [saved, binding.revision, dirty]);
  return <div className="github-grant stack">
    <Field label={agent.name} hint={!agent.capabilities?.includes("files-and-commands") ? "Files and commands is disabled in the latest definition." : undefined}>{props => <Select {...props} value={permission} disabled={disabled} onChange={event => { setPermission(event.target.value as typeof permission); setDirty(true); }}><option value="none">No access</option><option value="read">Read · clone and fetch</option><option value="write">Write · clone, fetch and push</option></Select>}</Field>
    {conflict ? <Notice tone="info">Saved access changed to {saved === "none" ? "No access" : saved}. Your choice is {permission === "none" ? "No access" : permission}.<Button variant="secondary" onClick={() => setReviewedRevision(binding.revision)}>I reviewed the current access</Button></Notice> : null}
    {dirty ? <div className="button-row"><Button variant="secondary" disabled={disabled} onClick={() => { setPermission(saved); setDirty(false); setReviewedRevision(binding.revision); }}>Discard access change</Button><Button disabled={disabled || conflict} onClick={async () => {
      if (await save({ action: "grant", projectId: binding.projectId, bindingId: binding.bindingId, definitionId: agent.id, permission, revision: reviewedRevision })) setDirty(false);
    }}>Save access</Button></div> : null}
  </div>;
}
