import { useState } from "react";
import type { ChatSummary, Project } from "../shared/contracts";
import { PROJECT_ARCHIVE_MAX_BYTES, type ProjectArchive, type ProjectArchivePreview } from "../shared/project-archives";
import { errorMessage, request } from "../lib/api";
import { Button, Field, Input, Modal, Notice, Spinner } from "./ui";

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a"); link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ProjectArchiveImport({ open, onOpenChange, onImported }: { open: boolean; onOpenChange: (open: boolean) => void; onImported: (project: Project) => void }) {
  const [source, setSource] = useState("");
  const [preview, setPreview] = useState<ProjectArchivePreview | null>(null);
  const [reviewed, setReviewed] = useState<ProjectArchive | null>(null);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [approved, setApproved] = useState(false);
  const [result, setResult] = useState<Project | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function choose(file?: File) {
    if (!file) return;
    if (attempted && !result && !window.confirm("The previous import may have succeeded. Retry it to avoid duplicates. Discard that operation?")) return;
    setBusy(true); setError(null); setPreview(null); setReviewed(null); setSource(""); setApproved(false); setResult(null); setAttempted(false); setRequestId(null);
    try {
      if (file.size > PROJECT_ARCHIVE_MAX_BYTES) throw new Error("Choose a project archive no larger than 32 MiB.");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await file.arrayBuffer());
      const response = await request<{ preview: ProjectArchivePreview }>("/api/project-archives/preview", { archive: text });
      setSource(text); setPreview(response.preview); setReviewed(JSON.parse(text) as ProjectArchive); setRequestId(crypto.randomUUID());
    } catch (error) { setError(error instanceof Error ? error.message : errorMessage(error)); }
    finally { setBusy(false); }
  }
  async function apply() {
    if (!requestId) return;
    setBusy(true); setAttempted(true); setError(null);
    try {
      const { project } = await request<{ project: Project }>("/api/project-archives/import", { archive: source, requestId });
      setResult(project); onImported(project);
    } catch (error) { setError(errorMessage(error)); }
    finally { setBusy(false); }
  }
  return <Modal title="Import project history" open={open} onOpenChange={onOpenChange} keepMounted>
    <div className="project-archive-panel">
      <Field label="Project archive (.json)">{props => <Input {...props} type="file" accept=".json,application/json" disabled={busy} onChange={event => { void choose(event.target.files?.[0]); event.target.value = ""; }} />}</Field>
      {preview ? <><h3>{preview.name}</h3><p>{preview.chats.length} chats · {(preview.bytes / 1024 / 1024).toFixed(1)} MiB</p>
        <ul>{preview.chats.map((chat, index) => <li key={index}><strong>{chat.title}</strong> — {chat.messages} messages, {chat.files} files<br />Historical authors: {chat.authors.join(", ") || "None"}</li>)}</ul>
        <Notice>New project. Only you become a manager. No agents or tasks are restored.</Notice>
        {reviewed ? <details><summary>Review archived content</summary><ArchiveContents archive={reviewed} /></details> : null}
        <label className="bundle-check"><input type="checkbox" checked={approved} disabled={busy || attempted} onChange={event => setApproved(event.target.checked)} /> I reviewed the content and destination access.</label>
        {result ? <Notice>Imported: {result.name}</Notice> : <Button disabled={busy || !approved} onClick={() => void apply()}>{busy ? <Spinner /> : null}{attempted ? "Retry same import" : "Import as new project"}</Button>}
      </> : null}
      {error ? <Notice>{error}</Notice> : null}
    </div>
  </Modal>;
}

export function ProjectArchiveActions({ project, chats }: { project: Project; chats: ChatSummary[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [approved, setApproved] = useState(false);
  const [archive, setArchive] = useState<ProjectArchive | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function run(exporting: boolean) {
    setBusy(true); setError(null);
    try {
      if (exporting) {
        const { archive } = await request<{ archive: ProjectArchive }>(`/api/projects/${project.id}/export`, { chatIds: selected });
        download(new Blob([JSON.stringify(archive)], { type: "application/json" }), "project-history.json");
      } else {
        const { archive } = await request<{ archive: ProjectArchive | null }>(`/api/projects/${project.id}/history`);
        setArchive(archive); setLoaded(true);
      }
    } catch (error) { setError(errorMessage(error)); if (!exporting) { setArchive(null); setLoaded(false); } }
    finally { setBusy(false); }
  }
  return <>
    <div className="button-row"><Button variant="secondary" disabled={busy} onClick={() => void run(false)}>View imported history</Button>{project.canManage ? <Button variant="secondary" onClick={() => setOpen(true)}>Export history</Button> : null}</div>
    {busy ? <Spinner label="Reading project history" /> : null}{error ? <Notice>{error}</Notice> : null}
    {loaded ? archive ? <section className="project-archive-panel"><h2>Imported history · Read-only</h2><ArchiveContents archive={archive} /></section> : <p className="text-muted">No imported history.</p> : null}
    <Modal title="Export project history" open={open} onOpenChange={setOpen} keepMounted><div className="project-archive-panel">
      <p>Choose chats. Any previously imported history is included in full.</p>
      {chats.filter(chat => chat.projectId === project.id).map(chat => <label className="bundle-check" key={chat.id}><input type="checkbox" checked={selected.includes(chat.id)} disabled={busy} onChange={event => setSelected(current => event.target.checked ? [...current, chat.id] : current.filter(id => id !== chat.id))} />{chat.title}{chat.archived ? " (archived)" : ""}</label>)}
      <Notice>Public messages and files may contain secrets. Review the downloaded archive before sharing.</Notice>
      <label className="bundle-check"><input type="checkbox" checked={approved} disabled={busy} onChange={event => setApproved(event.target.checked)} /> I understand this export may contain private information.</label>
      <Button disabled={busy || !approved || selected.length > 100} onClick={() => void run(true)}>{busy ? <Spinner /> : null}Download history</Button>
      {error ? <Notice>{error}</Notice> : null}
    </div></Modal>
  </>;
}

function ArchiveContents({ archive }: { archive: ProjectArchive }) {
  return <div className="project-archive-panel">{archive.chats.map(chat => <details key={chat.key}><summary>{chat.title} ({chat.messages.length} messages)</summary>
    {chat.messages.map(message => <article className="archived-message" key={message.key}>
      <header><strong>{chat.authors.find(author => author.key === message.author)?.name}</strong> <time dateTime={new Date(message.createdAt).toISOString()}>{new Date(message.createdAt).toLocaleString()}</time></header>
      {message.thread ? <p className="text-muted">Reply to {message.thread}</p> : null}
      <pre>{message.text}</pre>
      {message.files.map(key => { const file = chat.files.find(file => file.key === key)!; return <Button key={key} variant="secondary" onClick={() => {
        const bytes = Uint8Array.from(atob(file.data), char => char.charCodeAt(0));
        download(new Blob([bytes], { type: "application/octet-stream" }), file.name.replace(/[\\/\u0000-\u001f\u007f]/g, "_") || "attachment");
      }}>Download {file.name}</Button>; })}
    </article>)}
  </details>)}</div>;
}
