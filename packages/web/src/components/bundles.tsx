import { GitHubBundles } from "./github-bundles";
import { StarterPicker } from "./starters";
import { useEffect, useRef, useState } from "react";
import type { AgentDefinition, SkillDefinition, ModelOption, ThinkingLevel } from "../shared/contracts";
import type { BundleImportResult, BundlePreview } from "../shared/bundles";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Button, Field, Input, Modal, Notice, Spinner } from "./ui";

export function BundlesDialog({ open, onClose, agents, models, onImported }: {
  open: boolean; onClose: () => void; agents: AgentDefinition[]; models: ModelOption[]; onImported: () => Promise<void>;
}) {
  const { api } = useSession();
  const [mode, setMode] = useState<"import" | "export" | "github">("import");
  const [skills, setSkills] = useState<SkillDefinition[]>([]);
  const [selectedAgents, setSelectedAgents] = useState<string[]>([]);
  const [selectedSkills, setSelectedSkills] = useState<string[]>([]);
  const [id, setId] = useState("my-agents"), [version, setVersion] = useState("1.0.0");
  const [archive, setArchive] = useState("");
  const [preview, setPreview] = useState<BundlePreview | null>(null);
  const [result, setResult] = useState<BundleImportResult | null>(null);
  const [error, setError] = useState("");
  const [githubBusy, setGithubBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const requestId = useRef<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    void api<{ skills: SkillDefinition[] }>("/api/skills", undefined, controller.signal).then(data => setSkills(data.skills))
      .catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [open, api]);
  function close() {
    if (busy || githubBusy) return;
    // Hiding preserves file, operation identity and export selections, including uncertain imports.
    onClose();
  }
  async function perform(action: () => Promise<void>) {
    if (inFlight.current) return;
    inFlight.current = true; setBusy(true); setError("");
    try { await action(); } catch (error) { setError(errorMessage(error)); }
    finally { inFlight.current = false; setBusy(false); }
  }
  async function chooseFile(file: File | undefined) {
    if (!file || inFlight.current) return;
    if (attempted && !result && !window.confirm("The previous import may have completed. Choose a different file anyway?")) return;
    setPreview(null); setResult(null); setArchive(""); setAuthorized(false); setAttempted(false); requestId.current = null;
    await perform(async () => {
      if (file.size > 8 * 1024 * 1024) { setError("Choose a ZIP no larger than 8 MiB."); return; }
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = ""; for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      const encoded = btoa(binary); setArchive(encoded);
      setPreview(await api<BundlePreview>("/api/bundles/preview", { archive: encoded }));
      requestId.current = crypto.randomUUID();
    });
  }
  async function chooseStarter(selection: { provider: string; modelId: string; thinkingLevel: ThinkingLevel }) {
    if (inFlight.current) return;
    if (attempted && !result && !window.confirm("The previous import may have completed. Choose a starter instead?")) return;
    setPreview(null); setResult(null); setArchive(""); setAuthorized(false); setAttempted(false); requestId.current = null;
    await perform(async () => {
      const output = await api<{ archive: string }>("/api/bundles/starters/developer", selection);
      setArchive(output.archive);
      setPreview(await api<BundlePreview>("/api/bundles/preview", { archive: output.archive }));
      requestId.current = crypto.randomUUID();
    });
  }
  async function importBundle() {
    await perform(async () => {
      if (!preview || !requestId.current) return;
      setAttempted(true);
      const imported = await api<BundleImportResult>("/api/bundles/import", { archive, requestId: requestId.current });
      setResult(imported);
      await onImported();
    });
  }
  async function exportBundle() {
    await perform(async () => {
      const output = await api<{ archive: string; filename: string }>("/api/bundles/export", { id, version, agentIds: selectedAgents,
        skills: skills.filter(item => selectedSkills.includes(item.id)).map(({ id, revision }) => ({ id, revision })) });
      const bytes = Uint8Array.from(atob(output.archive), char => char.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: "application/zip" }));
      const link = document.createElement("a"); link.href = url; link.download = output.filename; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }
  function toggle(values: string[], id: string) { return values.includes(id) ? values.filter(value => value !== id) : [...values, id]; }
  return <Modal title="Agent bundles" open={open} onOpenChange={value => { if (!value) close(); }}>
    <div className="bundle-content">
      <div className="bundle-actions" aria-label="Bundle action">
        <Button variant={mode === "import" ? "primary" : "secondary"} disabled={busy || githubBusy} aria-pressed={mode === "import"} onClick={() => setMode("import")}>Import</Button>
        <Button variant={mode === "export" ? "primary" : "secondary"} disabled={busy || githubBusy} aria-pressed={mode === "export"} onClick={() => setMode("export")}>Export</Button>
        <Button variant={mode === "github" ? "primary" : "secondary"} disabled={busy || githubBusy} aria-pressed={mode === "github"} onClick={() => setMode("github")}>GitHub</Button>
      </div>
      <div hidden={mode !== "github"}><GitHubBundles onImported={onImported} onBusyChange={setGithubBusy} /></div>
      <div hidden={mode === "github"}>
      {error ? <Notice>{error}</Notice> : null}
      {mode !== "export" ? <>
        <StarterPicker models={models} disabled={busy} onPreview={selection => void chooseStarter(selection)} />
        <Field label="Bundle ZIP" hint="Up to 8 MiB. Local copies only.">{props => <Input {...props} type="file" accept=".zip,application/zip" disabled={busy} onChange={event => { void chooseFile(event.target.files?.[0]); event.target.value = ""; }} />}</Field>
        {preview ? <>
          <h3>{preview.bundle.id} <small>{preview.bundle.version}</small></h3>
          {preview.blockers.map((text, i) => <Notice key={i}>{text}</Notice>)}
          {preview.warnings.map((text, i) => <Notice key={i} tone="info">{text}</Notice>)}
          <div className="bundle-definitions">
            {preview.bundle.agents.map(agent => <details key={agent.key}><summary>{agent.name} <small>Agent</small></summary>
              <p>{agent.description}</p><p>{agent.provider} / {agent.modelId} / {agent.thinkingLevel}</p>
              <p>Capabilities: {agent.capabilities.join(", ") || "None"}</p>
              <p>Skills: {agent.skills.map(key => preview.bundle.skills.find(skill => skill.key === key)?.name ?? key).join(", ") || "None"}</p>
              {agent.omittedConnections ? <p>{agent.omittedConnections} connections excluded</p> : null}
              <pre>{agent.instructions}</pre>
            </details>)}
            {preview.bundle.skills.map(skill => <details key={skill.key}><summary>{skill.name} <small>Skill</small></summary><p>{skill.description}</p><pre>{skill.instructions}</pre></details>)}
          </div>
          {result ? <><Notice tone="success">Imported {result.agents.length} agents and {result.skills.length} skills.</Notice>
            <Button variant="secondary" onClick={() => { requestId.current = crypto.randomUUID(); setResult(null); setAttempted(false); setAuthorized(false); }}>Import another copy</Button></> : <>
            <label className="choice-row"><input type="checkbox" checked={authorized} disabled={busy || preview.blockers.length > 0} onChange={event => setAuthorized(event.target.checked)} /><span>Allow the listed capabilities for these copies</span></label>
            <Button disabled={busy || !authorized || preview.blockers.length > 0} onClick={() => void importBundle()}>{busy ? <Spinner /> : null}{attempted ? "Retry same import" : "Import copies"}</Button>
          </>}
        </> : null}
      </> : <>
        <Field label="Package ID">{props => <Input {...props} value={id} disabled={busy} maxLength={100} onChange={event => setId(event.target.value)} />}</Field>
        <Field label="Version">{props => <Input {...props} value={version} disabled={busy} maxLength={100} onChange={event => setVersion(event.target.value)} />}</Field>
        <fieldset disabled={busy}><legend>Agents</legend>{agents.filter(agent => !agent.archived).map(agent => <label className="choice-row" key={agent.id}><input type="checkbox" checked={selectedAgents.includes(agent.id)} onChange={() => setSelectedAgents(toggle(selectedAgents, agent.id))} /><span>{agent.name}</span></label>)}</fieldset>
        <fieldset disabled={busy}><legend>Additional skills</legend>{skills.map(skill => <label className="choice-row" key={skill.id}><input type="checkbox" checked={selectedSkills.includes(skill.id)} onChange={() => setSelectedSkills(toggle(selectedSkills, skill.id))} /><span>{skill.name} <small>Revision {skill.revision}</small></span></label>)}</fieldset>
        <Notice tone="info">Assigned skill revisions are included. Connections and credentials are excluded. Review instruction text for private information before sharing.</Notice>
        <Button disabled={busy || (!selectedAgents.length && !selectedSkills.length) || !id || !version} onClick={() => void exportBundle()}>{busy ? <Spinner /> : null}Download ZIP</Button>
      </>}
      </div>
    </div>
  </Modal>;
}
