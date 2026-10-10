import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project, ProjectSpecDocument } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Markdown } from "./markdown";
import { Button, Notice, Spinner } from "./ui";

const CodeEditor = lazy(() => import("./code-editor"));

type Source = { projectId: string; repositoryId: string; url: string; path: string };

/** The configured spec's source identity; a changed URL can keep its repository ID. */
export function projectSpecSource(project: Project): Source | null {
  const spec = project.spec;
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
 * Reads the project's spec at a pinned commit. Editing is an in-memory draft
 * only: there is no save destination in this slice, so nothing claims Saved.
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
    setDoc(null); setError(""); setEditing(false); setDirty(false); setSourceShown(false); draft.current = null;
    if (!requested) return;
    const source = JSON.parse(requested) as [string, string, string, string];
    const controller = new AbortController();
    void api<{ spec: ProjectSpecDocument }>(`/api/projects/${encodeURIComponent(source[0])}/spec`, undefined, controller.signal).then(({ spec }) => {
      if (controller.signal.aborted) return;
      // Never present one source's content under another reference.
      if (sourceKey(spec) !== requested) { setError("The project's spec reference changed while loading. Reload to open the current spec."); return; }
      setDoc(spec);
      const sourceDefault = !isMarkdown(spec.path);
      setView(sourceDefault ? "source" : "preview");
      setSourceShown(sourceDefault);
    }).catch(error => { if (!controller.signal.aborted) setError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, requested, attempt]);

  const onChange = useCallback((text: string) => {
    draft.current = text;
    setDirty(Boolean(doc) && text !== doc!.content);
  }, [doc]);

  function confirmDiscard() {
    return !dirty || window.confirm("Discard your unsaved spec draft? It hasn't been saved anywhere.");
  }
  function discard() {
    if (!confirmDiscard()) return;
    draft.current = null; setDirty(false); setEditing(false); setSession(value => value + 1);
  }
  function showSource() { setSourceShown(true); setView("source"); }
  function edit() { setEditing(true); showSource(); }
  function back() { if (confirmDiscard()) onBack(); }
  function openCurrent() {
    if (!confirmDiscard()) return;
    setDirty(false); setRequested(currentKey);
  }

  const shown = doc && sourceKey(doc) === requested ? doc : null;
  const repository = shown ? repositoryLabel(shown.url) : current ? repositoryLabel(current.url) : "";
  return <section className="project-spec-page" aria-labelledby={`project-spec-title-${project.id}`}>
    <a className="project-spec-back" href={`?${new URLSearchParams({ project: project.id })}`} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); back();
    }}><ArrowLeft size={18} aria-hidden="true" />{project.name}</a>
    <header className="project-spec-header">
      <div>
        <h1 ref={heading} id={`project-spec-title-${project.id}`} tabIndex={-1}>Spec</h1>
        <p className="project-spec-path">{shown?.path ?? project.spec?.path ?? "No spec file configured"}</p>
        {shown ? <p className="project-spec-provenance"><span>{repository}</span> · <span><span aria-hidden="true">{shown.commit.slice(0, 7)}</span><span className="sr-only">loaded at commit {shown.commit}</span></span></p> : null}
      </div>
      {shown && !editing ? <Button variant="secondary" onClick={edit}>Edit</Button> : null}
    </header>
    {requested !== currentKey ? <Notice tone="info">{currentKey ? "Spec reference changed · previous-file draft" : project.spec?.source === "directory" ? "Spec changed to a directory reference · previous-file draft" : "Spec reference removed · previous-file draft"} <Button variant="ghost" onClick={openCurrent}>{currentKey ? "Open current spec" : "Discard previous draft"}</Button></Notice> : null}
    {!current && !shown ? <p className="text-muted">{project.spec?.source === "directory" ? "Directory-backed specs aren't available in this view." : "This project has no spec file configured."}</p> : null}
    {error ? <Notice>{error} <Button variant="ghost" onClick={() => setAttempt(value => value + 1)}>Retry</Button></Notice> : null}
    {requested && !shown && !error ? <Spinner label="Loading spec" /> : null}
    {shown ? <>
      <div className="project-spec-toolbar">
        <div className="segmented-control" role="group" aria-label="Spec view">
          <Button variant="ghost" aria-pressed={view === "preview"} onClick={() => setView("preview")}>Preview</Button>
          <Button variant="ghost" aria-pressed={view === "source"} onClick={showSource}>Source</Button>
        </div>
        {editing ? <div className="project-spec-draft">
          <span role="status">{dirty ? "Draft · not saved" : "Editing · no changes"}</span>
          <Button variant="secondary" onClick={discard}>Discard</Button>
        </div> : null}
      </div>
      {view === "preview" ? <div className="project-spec-preview"><Markdown>{draft.current ?? shown.content}</Markdown></div> : null}
      {/* One editor instance survives view switches so selection and undo persist. */}
      {sourceShown ? <div className="project-spec-source" hidden={view !== "source"} inert={view !== "source"}>
        <Suspense fallback={<Spinner label="Loading editor" />}>
          <CodeEditor documentId={`${requested}:${shown.commit}:${session}`} path={shown.path} initialValue={shown.content}
            readOnly={!editing} autoFocus={editing} label={`Spec source, ${shown.path}${editing ? ", editing" : ", read-only"}`} onChange={onChange} />
        </Suspense>
      </div> : null}
    </> : null}
  </section>;
}
