import { ExternalLink, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ProviderLogin, ProviderStatus } from "../shared/provider-setup";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Modal, Notice, Select, Spinner } from "./ui";

type ProviderList = { providers: ProviderStatus[]; attempt: ProviderLogin | null };
type Method = ProviderStatus["methods"][number];
const root = "/api/model-providers";
const statusLabels: Record<ProviderStatus["state"], string> = {
  not_connected: "Not connected", key_saved: "Key saved", authorized: "Authorized",
  reconnect_required: "Reconnect required", externally_managed: "Externally managed", unavailable: "Unavailable",
};
function methodLabel(method: Method, provider: ProviderStatus) {
  return method === "api_key" ? "API key" : provider.id === "openai" ? "ChatGPT (OAuth)" : "OAuth";
}
function ongoing(attempt: ProviderLogin) { return attempt.state === "working" || attempt.state === "awaiting_input"; }

function ProviderPrompt({ prompt, busy, onAnswer }: {
  prompt: NonNullable<ProviderLogin["prompt"]>; busy: boolean; onAnswer: (value: string) => void;
}) {
  const [value, setValue] = useState("");
  const label = prompt.type === "secret" ? "API key" : prompt.type === "manual_code" ? "Redirect URL"
    : prompt.type === "select" ? "Sign-in method" : prompt.message;
  return <form className="connection-dialog-form" onSubmit={event => {
    event.preventDefault();
    if (busy || !value.trim()) return;
    onAnswer(value);
    setValue("");
  }}>
    <Field label={label} hint={prompt.type === "manual_code" ? "Paste the full URL from the localhost page after sign-in." : undefined}>{props =>
      prompt.type === "select" ? <Select {...props} autoFocus required value={value} disabled={busy} onChange={event => setValue(event.target.value)}>
        <option value="" disabled>Choose a method</option>
        {prompt.options?.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
      </Select> : <Input {...props} autoFocus required type={prompt.type === "secret" || prompt.type === "manual_code" ? "password" : "text"}
        value={value} disabled={busy} autoComplete="new-password" spellCheck={false} autoCapitalize="none"
        onChange={event => setValue(event.target.value)} />}
    </Field>
    <div className="button-row"><Button type="submit" disabled={busy || !value.trim()}>{busy ? <Spinner /> : null}{prompt.type === "secret" ? "Save key" : "Continue"}</Button></div>
  </form>;
}

function ProviderLoginDialog({ provider, initialAttempt, reconnect, open, onFinished }: {
  provider: ProviderStatus; initialAttempt?: ProviderLogin; reconnect: boolean; open: boolean; onFinished: (changed?: boolean) => void;
}) {
  const { api } = useSession();
  const [method, setMethod] = useState<Method>(provider.type && provider.methods.includes(provider.type) ? provider.type : provider.methods[0]);
  const [attempt, setAttempt] = useState<ProviderLogin | null>(initialAttempt ?? null);
  const [busy, setBusy] = useState<"starting" | "answering" | "cancelling" | "reloading" | null>(null);
  const [error, setError] = useState("");
  const [pollVersion, setPollVersion] = useState(0);
  const inFlight = useRef(false);
  const generation = useRef(0);
  const started = useRef(Boolean(initialAttempt));
  const finished = useRef(false);
  const mayHaveChanged = useRef(Boolean(initialAttempt));
  const activeAttempt = attempt && ongoing(attempt);

  const recover = async () => {
    const result = await api<ProviderList>(root);
    if (result.attempt?.providerId === provider.id) setAttempt(result.attempt);
    else onFinished(mayHaveChanged.current);
  };
  const start = async () => {
    if (inFlight.current) return;
    inFlight.current = true; mayHaveChanged.current = true; generation.current += 1; setBusy("starting"); setError("");
    try {
      setAttempt(await api<ProviderLogin>(`${root}/${provider.id}/connect`, { type: method, revision: provider.revision }));
      mayHaveChanged.current = method === "oauth";
    }
    catch (error) {
      setError(errorMessage(error));
      // A lost response can hide an admitted login. Discover it; never replay Connect.
      try {
        const result = await api<ProviderList>(root);
        if (result.attempt?.providerId === provider.id) { setAttempt(result.attempt); setError(""); }
        else if (result.attempt) setError("Another provider setup is active. Close and resume it.");
      } catch { /* Keep the original error and offer explicit recovery. */ }
    } finally { inFlight.current = false; setBusy(null); }
  };

  useEffect(() => {
    if (!started.current && (reconnect || provider.methods.length === 1)) {
      started.current = true;
      void start();
    }
  }, []);

  useEffect(() => {
    if (!attempt || !activeAttempt || busy) return;
    const controller = new AbortController();
    const current = generation.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<ProviderLogin>(`${root}/attempts/${encodeURIComponent(attempt.id)}`, undefined, controller.signal);
        if (controller.signal.aborted || current !== generation.current) return;
        setAttempt(next); setError("");
        if (ongoing(next)) timer = setTimeout(() => { void poll(); }, 1000);
      } catch (error) { if (!controller.signal.aborted && current === generation.current) setError(errorMessage(error)); }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [api, attempt?.id, activeAttempt, busy, pollVersion]);

  useEffect(() => {
    if ((attempt?.state === "saved" || attempt?.state === "cancelled") && !finished.current) {
      finished.current = true;
      onFinished(attempt.state === "saved" || mayHaveChanged.current);
    }
  }, [attempt?.state, onFinished]);

  async function answer(value: string) {
    if (!attempt?.prompt || inFlight.current) return;
    inFlight.current = true; mayHaveChanged.current = true; generation.current += 1; setBusy("answering"); setError("");
    try { setAttempt(await api<ProviderLogin>(`${root}/attempts/${encodeURIComponent(attempt.id)}/answer`, { promptId: attempt.prompt.id, value })); }
    catch (error) { setError(errorMessage(error)); }
    finally { inFlight.current = false; setBusy(null); }
  }
  async function close() {
    if (inFlight.current) return;
    if (!attempt || !ongoing(attempt)) { onFinished(mayHaveChanged.current); return; }
    inFlight.current = true; generation.current += 1; setBusy("cancelling"); setError("");
    try { setAttempt(await api<ProviderLogin>(`${root}/attempts/${encodeURIComponent(attempt.id)}/cancel`, {})); }
    catch (error) { setError(errorMessage(error)); }
    finally { inFlight.current = false; setBusy(null); }
  }
  async function reload() {
    if (inFlight.current) return;
    inFlight.current = true; generation.current += 1; setBusy("reloading"); setError("");
    try {
      await recover();
      setPollVersion(version => version + 1);
    } catch (error) { setError(errorMessage(error)); }
    finally { inFlight.current = false; setBusy(null); }
  }
  const terminalError = attempt?.state === "failed" ? attempt.message || "Setup could not be confirmed." : "";
  return <Modal title={`${reconnect ? "Reconnect" : provider.type ? "Update" : "Connect"} ${provider.name}`}
    open={open} onOpenChange={next => { if (!next) void close(); }} finalFocus={() => document.getElementById(`provider-${provider.id}`)}>
    <div className="provider-login connection-dialog-form" aria-busy={Boolean(busy)}>
      {error || terminalError ? <Notice>{error || terminalError}<Button variant="ghost" disabled={Boolean(busy)} onClick={() => void reload()}>Reload status</Button></Notice> : null}
      {!attempt && !busy && !error ? <form className="connection-dialog-form" onSubmit={event => { event.preventDefault(); void start(); }}>
        <Field label="Method">{props => <Select {...props} value={method} onChange={event => setMethod(event.target.value as Method)}>
          {provider.methods.map(value => <option key={value} value={value}>{methodLabel(value, provider)}</option>)}
        </Select>}</Field>
        {provider.type ? <p className="field-hint">Current credentials stay until saved.</p> : null}
        <div className="button-row"><Button variant="secondary" onClick={() => void close()}>Cancel</Button><Button type="submit">Continue</Button></div>
      </form> : null}
      {busy === "starting" || busy === "cancelling" || busy === "reloading" ? <p className="provider-progress"><Spinner />{busy === "starting" ? "Starting setup…" : busy === "cancelling" ? "Finishing setup…" : "Reloading status…"}</p> : null}
      {activeAttempt ? <>
        {attempt.authorizationUrl ? <a className="button button-secondary provider-auth-link" href={attempt.authorizationUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
          <ExternalLink aria-hidden="true" /> Open {provider.name}<span className="sr-only"> (opens in a new tab)</span>
        </a> : null}
        {attempt.userCode ? <p className="provider-device-code">Code: <strong>{attempt.userCode}</strong></p> : null}
        {attempt.prompt && busy !== "cancelling" ? <ProviderPrompt key={attempt.prompt.id} prompt={attempt.prompt} busy={Boolean(busy) || Boolean(error)} onAnswer={value => void answer(value)} /> : null}
        {!attempt.prompt && !busy && !error ? <p className="provider-progress"><Spinner />Waiting for authorization…</p> : null}
      </> : null}
      {attempt || busy || error ? <div className="button-row"><Button variant="secondary" disabled={Boolean(busy)} onClick={() => void close()}>{activeAttempt ? "Cancel" : "Close"}</Button></div> : null}
    </div>
  </Modal>;
}

export function ModelProvidersPage({ active, onChanged }: { active: boolean; onChanged: () => void }) {
  const { api } = useSession();
  const [data, setData] = useState<ProviderList | null>(null);
  const [error, setError] = useState("");
  const [version, setVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<{ provider: ProviderStatus; attempt?: ProviderLogin; reconnect: boolean } | null>(null);
  const [disconnect, setDisconnect] = useState<ProviderStatus | null>(null);
  const [disconnectError, setDisconnectError] = useState("");
  const [disconnecting, setDisconnecting] = useState(false);
  const disconnectPending = useRef(false);
  const reload = useCallback(() => setVersion(value => value + 1), []);
  const finished = useCallback((changed = false) => { setEditing(null); reload(); if (changed) onChanged(); }, [reload, onChanged]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setLoading(true);
    void api<ProviderList>(root, undefined, controller.signal)
      .then(result => { if (!controller.signal.aborted) { setData(result); setError(""); } })
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, active, version]);

  async function remove() {
    if (!disconnect || disconnectPending.current) return;
    disconnectPending.current = true; setDisconnecting(true); setDisconnectError("");
    try {
      const result = await api<{ providers: ProviderStatus[] }>(`${root}/${disconnect.id}/disconnect`, { revision: disconnect.revision });
      setData({ providers: result.providers, attempt: null }); setDisconnect(null); reload(); onChanged();
    } catch (error) { setDisconnectError(errorMessage(error)); }
    finally { disconnectPending.current = false; setDisconnecting(false); }
  }
  function closeDisconnect() {
    if (disconnecting) return;
    setDisconnect(null);
    if (disconnectError) { reload(); onChanged(); }
  }
  const resumeProvider = data?.providers.find(provider => provider.id === data.attempt?.providerId);
  return <section className="agent-view connections-page model-providers-page">
    <header className="view-heading"><h1>Model providers</h1><Button variant="ghost" disabled={loading || Boolean(editing) || disconnecting} onClick={reload}><RefreshCw /> Reload</Button></header>
    <div className="agent-content"><div className="connections-page-inner">
      <p className="field-hint">Shared with workspace agents</p>
      {error ? <Notice>{error}</Notice> : null}
      {loading && !data ? <p className="provider-progress"><Spinner />Loading providers…</p> : null}
      {data?.attempt && resumeProvider ? <Notice tone="info">Setup in progress.<Button variant="ghost" onClick={() => setEditing({ provider: resumeProvider, attempt: data.attempt!, reconnect: false })}>Resume setup</Button></Notice> : null}
      {data?.providers.length === 0 ? <p className="field-hint">No providers available.</p> : null}
      {data?.providers.map(provider => {
        const saved = provider.state === "authorized" || provider.state === "key_saved";
        const uncertain = provider.state === "reconnect_required";
        const disabled = loading || Boolean(error) || Boolean(editing) || Boolean(data.attempt) || disconnecting;
        return <article className="connection-card model-provider-card" key={provider.id} aria-labelledby={`provider-${provider.id}`}>
          <div className="connection-heading"><h2 id={`provider-${provider.id}`} tabIndex={-1}>{provider.name}</h2><span className="revision-badge">{statusLabels[provider.state]}</span></div>
          {provider.type ? <p className="field-hint">{methodLabel(provider.type, provider)}</p> : null}
          {provider.type === "oauth" ? <p className="provider-account">{provider.account || "Account not provided"}</p> : null}
          {provider.state === "externally_managed" ? <p className="field-hint">Operator credentials remain active.</p> : null}
          {provider.state === "unavailable" ? <p className="field-hint">Credential storage unavailable. Contact your operator.</p> : null}
          {uncertain ? <p className="field-hint">Disconnect the uncertain credential before reconnecting.</p> : null}
          <div className="button-row">
            {provider.state !== "unavailable" && !uncertain ? <Button variant={saved ? "secondary" : "primary"} disabled={disabled}
              onClick={() => setEditing({ provider, reconnect: false })}>{saved ? provider.type === "oauth" && provider.methods.includes("oauth") ? "Change account" : "Replace key" : "Connect"}</Button> : null}
            {saved && provider.type === "oauth" && provider.methods.includes("oauth") ? <Button variant="secondary" disabled={disabled} onClick={() => setEditing({ provider, reconnect: true })}>Reconnect</Button> : null}
            {saved || uncertain ? <Button variant="ghost" disabled={disabled} onClick={() => { setDisconnectError(""); setDisconnect(provider); }}>Disconnect</Button> : null}
          </div>
        </article>;
      })}
    </div></div>
    {editing ? <ProviderLoginDialog provider={editing.provider} initialAttempt={editing.attempt} reconnect={editing.reconnect} open={active} onFinished={finished} /> : null}
    {disconnect ? <Modal title={`Disconnect ${disconnect.name}?`} description="Remove Dispatch’s saved credential. Operator credentials may still apply; revoke provider access separately."
      open={active} onOpenChange={open => { if (!open) closeDisconnect(); }} finalFocus={() => document.getElementById(`provider-${disconnect.id}`)}>
      {disconnectError ? <Notice>{disconnectError}<Button variant="ghost" onClick={closeDisconnect}>Reload status</Button></Notice> : null}
      <div className="button-row"><Button variant="secondary" disabled={disconnecting} onClick={closeDisconnect}>Cancel</Button><Button variant="danger" disabled={disconnecting || Boolean(disconnectError)} onClick={() => void remove()}>{disconnecting ? <Spinner /> : null}Disconnect</Button></div>
    </Modal> : null}
  </section>;
}
