import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project, ProjectSpecDocument } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Markdown } from "./markdown";
import { Button, Notice, Spinner } from "./ui";

const CodeEditor = lazy(() => import("./code-editor"));

type Source = { projectId: string; repositoryId: string; url: string; path: string };

/** The configured spec's source identity; a changed URL can keep its repository ID. */
export function projectSpecSource(project: Project): Source | null {
  const spec = project.spec;
  if (spec?.source === "directory") return project.cwd ? { projectId: project.id, repositoryId: "", url: project.cwd, path: spec.path } : null;
  if (spec?.source !== "repository") return null;
  const repository = project.repositories?.find(item => item.id === spec.repositoryId);
  return repository ? { projectId: project.id, repositoryId: repository.id, url: repository.url, path: spec.path } : null;
}
const sourceKey = (source: Source | null) => source ? JSON.stringify([source.projectId, source.repositoryId, source.url, source.path]) : "";
const isMarkdown = (path: string) => /\.(?:md|markdown|mdx)$/i.test(path);

function repositoryLabel(url: string) {
  try { return new URL(url).pathname.replace(/^\/|\/$|\.git$/g, ""); } catch { return url; }
}

/**
 * Local files have explicit conflict-checked Save; repository previews remain draft-only.
 */
export function ProjectSpecView({ project, active, onBack, onDirtyChange }: {
  project: Project;
  active: boolean;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const { api } = useSession();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => { if (active) heading.current?.focus({ preventScroll: true }); }, [active]);
  const current = projectSpecSource(project);
  const currentKey = sourceKey(current);
  const [requested, setRequested] = useState(currentKey);
  const [doc, setDoc] = useState<ProjectSpecDocument | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const saveInFlight = useRef(false);
  const retrySubmission = useRef<string | null>(null);
  const [saveError, setSaveError] = useState("");
  const [saveBlocked, setSaveBlocked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copyStatus, setCopyStatus] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<"preview" | "source">("preview");
  const [editing, setEditing] = useState(false);
  const [session, setSession] = useState(0);
  const [dirty, setDirty] = useState(false);
  // Load the editor only once Source is first shown, then keep it mounted.
  const [sourceShown, setSourceShown] = useState(false);
  const draft = useRef<string | null>(null);

  // Follow reference changes automatically unless that would discard edits.
  useEffect(() => { if (!dirty) setRequested(currentKey); }, [currentKey, dirty]);
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
    setError("");
    if (!requested) return;
    setLoading(true);
    const source = JSON.parse(requested) as [string, string, string, string];
    const controller = new AbortController();
    void api<{ spec: ProjectSpecDocument }>(`/api/projects/${encodeURIComponent(source[0])}/spec`, undefined, controller.signal).then(({ spec }) => {
      if (controller.signal.aborted) return;
      // Never present one source's content under another reference.
      if (sourceKey(spec) !== requested) { setError("The project's spec reference changed while loading. Reload to open the current spec."); setLoading(false); return; }
      setDoc(spec); setEditing(false); setDirty(false); draft.current = null;
      setSaveError(""); setSaveBlocked(false); setSaved(false); setCopyStatus(""); retrySubmission.current = null;
      setSession(value => value + 1);
      setLoading(false);
      const sourceDefault = !isMarkdown(spec.path);
      setView(sourceDefault ? "source" : "preview");
      setSourceShown(sourceDefault);
    }).catch(error => { if (!controller.signal.aborted) { setError(errorMessage(error)); setLoading(false); } });
    return () => controller.abort();
  }, [api, requested, attempt]);

  const onChange = useCallback((text: string) => {
    draft.current = text;
    setSaved(false); setCopyStatus("");
    setDirty(Boolean(doc) && text !== doc!.content);
  }, [doc]);

  function confirmDiscard() {
    if (saveInFlight.current) return false;
    return !dirty || window.confirm("Discard your unsaved spec draft?");
  }
  function discard() {
    if (!confirmDiscard()) return;
    draft.current = null; setDirty(false); setEditing(false); setSaved(false); setCopyStatus(""); setSession(value => value + 1);
  }
  function showSource() { setSourceShown(true); setView("source"); }
  function edit() { setEditing(true); showSource(); }
  function back() { if (confirmDiscard()) onBack(); }
  function openCurrent() {
    if (!confirmDiscard()) return;
    if (!currentKey) { setDoc(null); draft.current = null; setDirty(false); setEditing(false); setLoading(false); }
    setRequested(currentKey); setAttempt(value => value + 1);
  }

  async function copyDraft() {
    try { await navigator.clipboard.writeText(draft.current ?? doc?.content ?? ""); setCopyStatus("Draft copied"); }
    catch { setCopyStatus("Could not copy. Select and copy the source text."); }
  }
  function reloadFile() { if (confirmDiscard()) setAttempt(value => value + 1); }
  const shown = doc;
  const shownKey = sourceKey(shown);
  const stale = Boolean(shown) && shownKey !== currentKey;
  const local = shown?.source === "directory";
  const canSave = Boolean(local && project.canManage && !stale && !saveBlocked && !loading && !error);
  async function save() {
    if (!doc || !canSave || !dirty || saveInFlight.current || !doc.binding || !doc.version) return;
    const submitted = retrySubmission.current ?? draft.current ?? doc.content;
    const originalKey = sourceKey(doc);
    saveInFlight.current = true; setSaving(true); setSaveError(""); setCopyStatus("");
    try {
      const { spec } = await api<{ spec: ProjectSpecDocument }>(`/api/projects/${encodeURIComponent(doc.projectId)}/spec`, {
        binding: doc.binding, expectedVersion: doc.version, content: submitted,
      });
      if (sourceKey(spec) !== originalKey || spec.binding !== doc.binding || spec.content !== submitted || !spec.version) {
        throw new Error("Unexpected Save acknowledgment");
      }
      setDoc(spec); setDirty(false); setSaved(true); retrySubmission.current = null;
      // Do not remount the editor: keep selection and undo after acknowledging Save.
    } catch (error) {
      retrySubmission.current = submitted;
      setSaveError(error instanceof ApiError ? error.message : "Could not confirm save. Your draft is kept.");
      setSaveBlocked(error instanceof ApiError && [400, 403, 404, 409, 413].includes(error.status));
    } finally { saveInFlight.current = false; setSaving(false); }
  }
  const repository = shown ? local ? shown.url : repositoryLabel(shown.url) : current ? repositoryLabel(current.url) : "";
  return <section className="project-spec-page" aria-labelledby={`project-spec-title-${project.id}`}>
    <a className="project-spec-back" href={`?${new URLSearchParams({ project: project.id })}`} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); back();
    }}><ArrowLeft size={18} aria-hidden="true" />{project.name}</a>
    <header className="project-spec-header">
      <div>
        <h1 ref={heading} id={`project-spec-title-${project.id}`} tabIndex={-1}>Spec</h1>
      </div>
      {shown && !editing && (!local || project.canManage) ? <Button variant="secondary" disabled={loading || stale} onClick={edit}>Edit</Button> : null}
      {editing ? <div className="project-spec-edit-actions">
        <Button variant="secondary" disabled={saving || loading} onClick={discard}>Discard</Button>
        {local ? <Button disabled={!canSave || !dirty || saving} onClick={() => void save()}>{saving ? "Saving…" : "Save"}</Button> : null}
      </div> : null}
      <p className="project-spec-path">{shown?.path ?? project.spec?.path ?? "No spec file configured"}</p>
      {shown ? <p className="project-spec-provenance">{local ? <>Project directory · {repository}</> : <><span>{repository}</span> · <span><span aria-hidden="true">{shown.commit.slice(0, 7)}</span><span className="sr-only">loaded at commit {shown.commit}</span></span></>}</p> : null}
    </header>
    {stale ? <Notice tone="info">{currentKey ? "Spec reference changed · previous-file draft" : "Spec reference removed · previous-file draft"} <Button variant="ghost" disabled={saving || loading} onClick={() => void copyDraft()}>Copy draft</Button> <Button variant="ghost" disabled={saving || loading} onClick={openCurrent}>{currentKey ? "Open current spec" : "Discard previous draft"}</Button></Notice> : null}
    {!current && !shown ? <p className="text-muted">{project.spec?.source === "directory" ? "Configure a project directory to open this spec." : "This project has no spec file configured."}</p> : null}
    {error ? <Notice>{error} <Button variant="ghost" disabled={saving || loading} onClick={reloadFile}>Retry</Button></Notice> : null}
    {loading && !error ? <Spinner label="Loading spec" /> : null}
    {shown ? <>
      <div className="project-spec-toolbar">
        <div className="segmented-control" role="group" aria-label="Spec view">
          <Button variant="ghost" aria-pressed={view === "preview"} onClick={() => setView("preview")}>Preview</Button>
          <Button variant="ghost" aria-pressed={view === "source"} onClick={showSource}>Source</Button>
        </div>
        <span className="project-spec-status" role="status">{saving ? "Saving…" : saveError ? "Unconfirmed" : saved ? "Saved" : dirty ? "Unsaved" : editing ? "Editing · no changes" : ""}</span>
      </div>
      {editing && !saveError ? <p className="project-spec-helper">{local ? "Writes this file only." : "Repository preview · draft only. No file Save."}</p> : null}
      {saveError ? <Notice>{saveError} <div className="project-spec-recovery">
        <Button variant="secondary" disabled={saving} onClick={() => void copyDraft()}>Copy draft</Button>
        <Button variant="secondary" disabled={saving || loading} onClick={reloadFile}>Reload file</Button>
        {!saveBlocked ? <Button disabled={!canSave || !dirty || saving} onClick={() => void save()}>Retry save</Button> : null}
      </div></Notice> : null}
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
      {view === "preview" ? <div className="project-spec-preview"><Markdown>{draft.current ?? shown.content}</Markdown></div> : null}
      {/* One editor instance survives view switches so selection and undo persist. */}
      {sourceShown ? <div className="project-spec-source" hidden={view !== "source"} inert={view !== "source"}>
        <Suspense fallback={<Spinner label="Loading editor" />}>
          <CodeEditor documentId={`${shownKey}:${session}`} path={shown.path} initialValue={shown.content}
            readOnly={!editing || saving || loading || Boolean(saveError && !saveBlocked)} autoFocus={editing} label={`Spec source, ${shown.path}${editing ? ", editing" : ", read-only"}`} onChange={onChange} />
        </Suspense>
      </div> : null}
    </> : null}
  </section>;
}
