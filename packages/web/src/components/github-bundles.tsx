import { useEffect, useRef, useState } from "react";
import type { GitHubBundleApplyResult, GitHubBundleChange, GitHubBundlePreview, GitHubBundleSource, GitHubInstallation } from "../shared/github-bundles";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Notice, Select, Spinner } from "./ui";

const emptySource: GitHubBundleSource = { owner: "", repository: "", commit: "", path: "" };
export function GitHubBundles({ onImported, onBusyChange }: { onImported: () => Promise<void>; onBusyChange: (busy: boolean) => void }) {
  const { api } = useSession();
  const [installations, setInstallations] = useState<GitHubInstallation[]>([]);
  const [installationId, setInstallationId] = useState("");
  const [source, setSource] = useState(emptySource);
  const [preview, setPreview] = useState<GitHubBundlePreview | null>(null);
  const [result, setResult] = useState<GitHubBundleApplyResult | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [attempted, setAttempted] = useState(false);
  const operation = useRef<string | null>(null), inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void api<{ installations: GitHubInstallation[] }>("/api/bundles/github", undefined, controller.signal)
      .then(value => setInstallations(value.installations)).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [api]);
  async function perform(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); onBusyChange(true); setError("");
    try { await action(); } catch (error) { setError(errorMessage(error)); }
    finally { inFlight.current = false; setBusy(false); onBusyChange(false); }
  }
  function abandon() {
    if (attempted && !result && !window.confirm("The previous operation may have completed. Abandon its retry?")) return false;
    setPreview(null); setResult(null); setAuthorized(false); setAttempted(false); operation.current = null;
    return true;
  }
  async function fetchPreview(copy = false) {
    if (inFlight.current || !abandon()) return;
    await perform(async () => {
      const next = await api<GitHubBundlePreview>("/api/bundles/github/preview", { source, ...(installationId && !copy ? { installationId } : {}) });
      setPreview(next); operation.current = crypto.randomUUID();
    });
  }
  async function apply() {
    if (!preview || !operation.current) return;
    await perform(async () => {
      setAttempted(true);
      const saved = await api<GitHubBundleApplyResult>("/api/bundles/github/apply", { previewId: preview.previewId, requestId: operation.current });
      setResult(saved);
      setInstallations(current => [...current.filter(item => item.id !== saved.installation.id), saved.installation]);
      await onImported();
    });
  }
  const valid = !!source.owner && !!source.repository && /^[a-fA-F0-9]{40}$/.test(source.commit);
  return <div className="bundle-content">
    <Field label="Destination">{props => <Select {...props} disabled={busy} value={installationId} onChange={event => {
      if (!abandon()) return;
      const id = event.target.value; setInstallationId(id);
      const installed = installations.find(item => item.id === id); setSource(installed ? installed.source : emptySource);
    }}><option value="">New independent copy</option>{installations.map(item => <option key={item.id} value={item.id}>Update {item.packageId} ({item.id.slice(0, 8)})</option>)}</Select>}</Field>
    <Field label="GitHub owner">{props => <Input {...props} disabled={busy || !!installationId} value={source.owner} onChange={event => { if (abandon()) setSource({ ...source, owner: event.target.value }); }} />}</Field>
    <Field label="Public repository">{props => <Input {...props} disabled={busy || !!installationId} value={source.repository} onChange={event => { if (abandon()) setSource({ ...source, repository: event.target.value }); }} />}</Field>
    <Field label="Package directory" hint="Leave empty for repository root.">{props => <Input {...props} disabled={busy || !!installationId} value={source.path} onChange={event => { if (abandon()) setSource({ ...source, path: event.target.value }); }} />}</Field>
    <Field label="Commit SHA" hint="Full 40-character commit; not a branch or tag.">{props => <Input {...props} disabled={busy} value={source.commit} maxLength={40} onChange={event => { if (abandon()) setSource({ ...source, commit: event.target.value }); }} />}</Field>
    <Button variant="secondary" disabled={busy || !valid} onClick={() => void fetchPreview()}>{busy ? <Spinner /> : null}Preview commit</Button>
    {error ? <Notice>{error}</Notice> : null}
    {preview ? <>
      <h3>{preview.bundle.id} <small>{preview.bundle.version}</small></h3>
      <p className="bundle-provenance">{preview.source.owner}/{preview.source.repository}<br />{preview.source.commit}</p>
      {preview.blockers.map((text, i) => <Notice key={i}>{text}</Notice>)}
      {preview.warnings.map((text, i) => <Notice key={i} tone="info">{text}</Notice>)}
      {preview.installationId ? <Notice tone="info">Active instances adopt updated definitions when idle. Existing connections remain in place.</Notice> : null}
      <div className="bundle-definitions">{preview.changes.map(change => <Change key={`${change.kind}:${change.key}`} change={change} />)}</div>
      {result ? <Notice tone="success">{preview.installationId ? "Update applied." : "Independent copy imported."}</Notice> : <>
        <label className="choice-row"><input type="checkbox" disabled={busy || !!preview.blockers.length} checked={authorized} onChange={event => setAuthorized(event.target.checked)} /><span>Approve these definitions and capability changes</span></label>
        <Button disabled={busy || !authorized || !!preview.blockers.length} onClick={() => void apply()}>{attempted ? "Retry same operation" : preview.installationId ? "Apply update" : "Import copy"}</Button>
        {preview.installationId ? <Button variant="secondary" disabled={busy} onClick={() => void fetchPreview(true)}>Preview independent copy</Button> : null}
      </>}
    </> : null}
  </div>;
}
function Change({ change }: { change: GitHubBundleChange }) {
  return <details><summary>{change.name} <small>{change.kind} · {change.action}</small></summary>
    {change.action === "removed" ? <p>Removed upstream; local definition retained.</p> : null}
    {([['Last imported', change.before], ['Local now', change.local], ['Incoming', change.incoming]] as const).map(([label, value]) => value ? <section key={label}>
      <h4>{label}</h4><p>{value.name}: {value.description}</p>
      {"capabilities" in value ? <><p>Capabilities: {value.capabilities.join(", ") || "None"}</p><p>Skills: {value.skills.join(", ") || "None"}</p><p>{value.provider} / {value.modelId} / {value.thinkingLevel}</p></> : null}
      <pre>{value.instructions}</pre>
    </section> : null)}
  </details>;
}
