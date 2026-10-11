import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ImportProjectMarkdownInput, Project, ProjectMarkdownDocument, ProjectSpecDocument, SaveProjectMarkdownInput } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Markdown } from "./markdown";
import { Button, Notice, Spinner } from "./ui";

const CodeEditor = lazy(() => import("./code-editor"));
type Submission = { kind: "save"; input: SaveProjectMarkdownInput } | { kind: "import"; input: ImportProjectMarkdownInput; content: string };

/** Database Markdown only; legacy sources can be reviewed and imported once, never edited here. */
export function ProjectSpecView({ project, active, editRequest, onBack, onDirtyChange, onSaved }: {
  project: Project;
  active: boolean;
  editRequest: number;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: () => void;
}) {
  const { api } = useSession();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { if (active) heading.current?.focus({ preventScroll: true }); }, [active]);
  const [doc, setDoc] = useState<ProjectMarkdownDocument | null>(null);
  const [legacy, setLegacy] = useState<ProjectSpecDocument | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const inFlight = useRef(false);
  const submission = useRef<Submission | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<"preview" | "source">("preview");
  const [editing, setEditing] = useState(false);
  const [session, setSession] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [sourceShown, setSourceShown] = useState(false);
  const draft = useRef<string | null>(null);
  const consumedEdit = useRef(0);
  const savedCallback = useRef(onSaved);
  savedCallback.current = onSaved;
  const reportDirty = useRef(onDirtyChange);
  reportDirty.current = onDirtyChange;
  useEffect(() => { reportDirty.current(dirty); }, [dirty]);
  useEffect(() => () => reportDirty.current(false), []);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    void (async () => {
      const { spec } = await api<{ spec: ProjectMarkdownDocument }>(`/api/projects/${encodeURIComponent(project.id)}/spec`, undefined, controller.signal);
      if (spec.projectId !== project.id) throw new Error("Unexpected spec response");
      const imported = spec.legacyImportRequired
        ? (await api<{ spec: ProjectSpecDocument }>(`/api/projects/${encodeURIComponent(project.id)}/spec/legacy`, undefined, controller.signal)).spec : null;
      if (controller.signal.aborted) return;
      if (imported && (imported.projectId !== project.id || imported.projectRevision === undefined)) throw new Error("Unexpected import preview");
      // Replace the draft only after the entire requested read succeeds.
      setDoc(spec); setLegacy(imported); draft.current = null;
      setEditing(false); setDirty(false); setSaveError(""); setSaveBlocked(false); setSaved(false); setCopyStatus(""); submission.current = null;
      setSession(value => value + 1); setView("preview"); setSourceShown(false); setLoading(false);
    })().catch(error => {
      if (!controller.signal.aborted) { setError(errorMessage(error)); setLoading(false); }
    });
    return () => controller.abort();
  }, [api, project.id, attempt]);

  useEffect(() => {
    if (!active || !doc || loading || error || doc.legacyImportRequired || !project.canManage || editRequest <= consumedEdit.current) return;
    consumedEdit.current = editRequest;
    setEditing(true); setView("source"); setSourceShown(true);
  }, [active, doc, loading, error, project.canManage, editRequest]);

  const onChange = useCallback((text: string) => {
    if (doc?.legacyImportRequired) return;
    draft.current = text; setSaved(false); setCopyStatus("");
    setDirty(Boolean(doc) && text !== doc!.content);
  }, [doc]);
  function confirmDiscard() { return !inFlight.current && (!dirty || window.confirm("Discard your unsaved spec draft?")); }
  function discard() {
    if (!confirmDiscard()) return;
    draft.current = null; submission.current = null;
    setDirty(false); setEditing(false); setSaved(false); setCopyStatus(""); setSaveError(""); setSaveBlocked(false); setSession(value => value + 1);
  }
  function showSource() { setSourceShown(true); setView("source"); }
  function edit() { consumedEdit.current = editRequest; setEditing(true); showSource(); }
  function back() { if (confirmDiscard()) onBack(); }
  function reloadSpec() { if (confirmDiscard()) setAttempt(value => value + 1); }
  async function copyDraft() {
    try { await navigator.clipboard.writeText(draft.current ?? legacy?.content ?? doc?.content ?? ""); setCopyStatus("Draft copied"); }
    catch { setCopyStatus("Could not copy. Select and copy the source text."); }
  }
  const canMutate = Boolean(project.canManage && doc && !loading && !error && !saveBlocked);
  async function persist(kind: "save" | "import") {
    if (!doc || !canMutate || inFlight.current || (kind === "save" && (!dirty || doc.legacyImportRequired)) || (kind === "import" && (!legacy || legacy.projectRevision === undefined))) return;
    let pending = submission.current;
    if (!pending) {
      if (kind === "save") pending = { kind, input: { requestId: crypto.randomUUID(), expectedRevision: doc.revision, content: draft.current ?? doc.content } };
      else {
        const contentHash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(legacy!.content)))).map(byte => byte.toString(16).padStart(2, "0")).join("");
        // Hash only the review's immutable text. No current settings are substituted into this submission.
        pending = { kind, content: legacy!.content, input: { requestId: crypto.randomUUID(), expectedProjectRevision: legacy!.projectRevision!, sourceVersion: legacy!.version ?? legacy!.commit, contentHash } };
      }
    }
    if (inFlight.current) return;
    submission.current = pending;
    inFlight.current = true; setSaving(true); setSaveError(""); setCopyStatus("");
    try {
      const { spec } = await api<{ spec: ProjectMarkdownDocument }>(`/api/projects/${encodeURIComponent(project.id)}/spec${pending.kind === "import" ? "/import" : ""}`, pending.input);
      const content = pending.kind === "import" ? pending.content : pending.input.content;
      const revision = pending.kind === "import" ? 1 : pending.input.expectedRevision + 1;
      if (spec.projectId !== project.id || spec.content !== content || spec.revision !== revision || spec.legacyImportRequired) throw new Error("Unexpected Save acknowledgment");
      setDoc(spec); setDirty(false); setSaved(true); setLegacy(null); submission.current = null;
      if (pending.kind === "import") { setEditing(false); setSession(value => value + 1); }
      // Save keeps the editor mounted: text, selection, Undo and selected view survive.
      savedCallback.current();
    } catch (error) {
      setSaveError(error instanceof ApiError ? error.message : pending.kind === "import" ? "Could not confirm import. Retry the same import or reload the spec." : "Could not confirm save. Your draft is kept.");
      setSaveBlocked(error instanceof ApiError && [400, 403, 404, 409, 413].includes(error.status));
    } finally { inFlight.current = false; setSaving(false); }
  }
  const content = draft.current ?? legacy?.content ?? doc?.content ?? "";
  const newer = doc && project.specRevision && project.specRevision > doc.revision;
  return <section className="project-spec-page" aria-labelledby={`project-spec-title-${project.id}`}>
    <a className="project-spec-back" href={`?${new URLSearchParams({ section: "projects", project: project.id })}`} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); back();
    }}><ArrowLeft size={18} aria-hidden="true" />{project.name}</a>
    <header className="project-spec-header">
      <div><h1 ref={heading} id={`project-spec-title-${project.id}`} tabIndex={-1}>Spec</h1></div>
      {doc && !doc.legacyImportRequired && !editing && project.canManage ? <Button variant="secondary" disabled={loading || Boolean(error)} onClick={edit}>{doc.revision ? "Edit spec" : "Write spec"}</Button> : null}
      {editing ? <div className="project-spec-edit-actions">
        <Button variant="secondary" disabled={saving || loading} onClick={discard}>Discard</Button>
        <Button disabled={!canMutate || !dirty || saving} onClick={() => void persist("save")}>{saving ? "Saving…" : "Save"}</Button>
      </div> : null}
      {doc ? <p className="project-spec-path">{doc.revision ? `Revision ${doc.revision}` : doc.legacyImportRequired ? "Import required" : "No spec yet"}</p> : null}
    </header>
    {newer ? <Notice tone="info">A newer revision is saved. This editor still uses revision {doc.revision}. <Button variant="ghost" disabled={saving || loading} onClick={reloadSpec}>Reload spec</Button></Notice> : null}
    {error ? <Notice>{error} <Button variant="ghost" disabled={saving || loading} onClick={reloadSpec}>Retry</Button></Notice> : null}
    {loading ? <Spinner label="Loading spec" /> : null}
    {doc ? <>
      {doc.legacyImportRequired ? <Notice tone="info">Review the existing Markdown, then import it into this project. Import retires the file reference; it does not change the file or start agents.
        {project.canManage ? <Button disabled={!canMutate || !legacy || saving} onClick={() => void persist("import")}>{saving ? "Importing…" : "Import spec"}</Button> : null}
      </Notice> : null}
      <div className="project-spec-toolbar">
        <div className="segmented-control" role="group" aria-label="Spec view">
          <Button variant="ghost" aria-pressed={view === "preview"} onClick={() => setView("preview")}>Preview</Button>
          <Button variant="ghost" aria-pressed={view === "source"} onClick={showSource}>Source</Button>
        </div>
        <span className="project-spec-status" role="status">{saving ? "Saving…" : saveError ? saveBlocked ? "Needs review" : "Unconfirmed" : saved ? `Saved · Revision ${doc.revision}` : dirty ? "Unsaved" : editing ? "Editing · no changes" : ""}</span>
      </div>
      {editing && !saveError ? <p className="project-spec-helper">Saves project Markdown. Does not start agents.</p> : null}
      {saveError ? <Notice>{saveError}<div className="project-spec-recovery">
        <Button variant="secondary" disabled={saving} onClick={() => void copyDraft()}>Copy draft</Button>
        <Button variant="secondary" disabled={saving || loading} onClick={reloadSpec}>Reload spec</Button>
        {!saveBlocked ? <Button disabled={!canMutate || saving} onClick={() => void persist(submission.current?.kind ?? "save")}>Retry {submission.current?.kind === "import" ? "import" : "save"}</Button> : null}
      </div></Notice> : null}
      {!project.canManage && editing ? <Notice>Management permission removed. Draft retained.</Notice> : null}
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
      {view === "preview" ? <div className="project-spec-preview"><Markdown>{content}</Markdown></div> : null}
      {sourceShown ? <div className="project-spec-source" hidden={view !== "source"} inert={view !== "source"}>
        <Suspense fallback={<Spinner label="Loading editor" />}>
          <CodeEditor documentId={`${project.id}:${session}`} path="spec.md" initialValue={legacy?.content ?? doc.content}
            readOnly={!editing || !project.canManage || saving || loading || Boolean(saveError && !saveBlocked)} autoFocus={editing} label={`Spec Markdown${editing ? ", editing" : ", read-only"}`} onChange={onChange} />
        </Suspense>
      </div> : null}
    </> : null}
  </section>;
}
