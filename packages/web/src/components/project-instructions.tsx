import { ArrowLeft } from "lucide-react";
import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Project, ProjectInstructionsDocument, SaveProjectInstructionsInput } from "../shared/contracts";
import { ApiError, errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Markdown } from "./markdown";
import { Button, Notice, Spinner } from "./ui";

const CodeEditor = lazy(() => import("./code-editor"));
type Failure = { kind: "uncertain" | "conflict" | "rejected"; message: string };

function checkedDocument(document: ProjectInstructionsDocument, projectId: string) {
  if (!document || document.projectId !== projectId || !Number.isSafeInteger(document.revision)
    || document.revision < 0 || typeof document.content !== "string") throw new Error("Unexpected instructions response");
  return document;
}

export function ProjectInstructionsView({ project, active, onBack, onDirtyChange, onSaved }: {
  project: Project;
  active: boolean;
  onBack: () => void;
  onDirtyChange: (dirty: boolean) => void;
  onSaved: (document: ProjectInstructionsDocument) => void;
}) {
  const { api } = useSession();
  // Base is the explicitly accepted save expectation. Reviewing a newer head
  // never rebases it, replaces the draft, or settles an uncertain submission.
  const [base, setBase] = useState<ProjectInstructionsDocument | null>(null);
  const [draft, setDraft] = useState("");
  const draftRef = useRef("");
  const [latest, setLatest] = useState<ProjectInstructionsDocument | null>(null);
  const [pending, setPending] = useState<Readonly<SaveProjectInstructionsInput> | null>(null);
  const inFlight = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [receipt, setReceipt] = useState<ProjectInstructionsDocument | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState("");
  const reviewRequest = useRef<AbortController | null>(null);
  const [copyStatus, setCopyStatus] = useState("");
  const [view, setView] = useState<"source" | "preview">(project.canManage ? "source" : "preview");
  const [sourceShown, setSourceShown] = useState(Boolean(project.canManage));
  const [editorSession, setEditorSession] = useState(0);
  const heading = useRef<HTMLHeadingElement>(null);
  const callbacks = useRef({ onDirtyChange, onSaved });
  callbacks.current = { onDirtyChange, onSaved };
  const dirty = Boolean(base && draft !== base.content);
  const needsRetention = dirty || Boolean(pending);
  const savedRevision = Math.max(project.instructionsRevision, base?.revision ?? 0, latest?.revision ?? 0);
  const newer = Boolean(base && savedRevision > base.revision);
  const mustReview = newer || failure?.kind === "conflict";
  const reviewStale = Boolean(latest && latest.revision < savedRevision);
  const validation = draft.length > 50_000 ? "Use 50,000 characters or fewer."
    : draft.includes("\0") ? "Remove the NUL character before saving." : "";
  const canSave = Boolean(project.canManage && base && dirty && !pending && !saving && !mustReview && !validation);
  const path = `/api/projects/${encodeURIComponent(project.id)}/instructions`;

  useLayoutEffect(() => { if (active) heading.current?.focus({ preventScroll: true }); }, [active]);
  useEffect(() => { callbacks.current.onDirtyChange(needsRetention); }, [needsRetention]);
  useEffect(() => () => { callbacks.current.onDirtyChange(false); reviewRequest.current?.abort(); }, []);
  useEffect(() => {
    if (!needsRetention) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [needsRetention]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError("");
    void api<{ instructions: ProjectInstructionsDocument }>(path, undefined, controller.signal).then(result => {
      if (controller.signal.aborted) return;
      const document = checkedDocument(result.instructions, project.id);
      setBase(document); draftRef.current = document.content; setDraft(document.content); setLoading(false);
    }).catch(error => {
      if (!controller.signal.aborted) { setLoadError(errorMessage(error)); setLoading(false); }
    });
    return () => controller.abort();
  }, [api, path, project.id, loadAttempt]);

  const changeDraft = useCallback((text: string) => {
    draftRef.current = text; setDraft(text); setReceipt(null); setCopyStatus("");
    setFailure(current => current?.kind === "rejected" ? null : current);
  }, []);
  function replaceDraft(content: string) {
    changeDraft(content); setEditorSession(value => value + 1);
  }
  function discard() {
    if (!base || inFlight.current || pending || !dirty || !window.confirm("Discard your local instructions draft? Saved instructions are unchanged.")) return;
    replaceDraft(base.content);
  }
  async function copyDraft() {
    try { await navigator.clipboard.writeText(draftRef.current); setCopyStatus("Draft copied"); }
    catch { setCopyStatus("Could not copy. Select and copy the source text."); }
  }
  async function submit(input: Readonly<SaveProjectInstructionsInput>) {
    if (!project.canManage || inFlight.current) return;
    inFlight.current = true; setSaving(true); setPending(input); setFailure(null); setReceipt(null); setCopyStatus("");
    try {
      const result = await api<{ instructions: ProjectInstructionsDocument }>(path, input);
      const document = checkedDocument(result.instructions, project.id);
      if (document.content !== input.content || document.revision < input.expectedRevision) throw new Error("Unexpected save acknowledgment");
      // A receipt may be older than a separately reviewed head. It confirms this
      // exact submission only. Never replace typing performed while it ran.
      setBase(document); setReceipt(document); setPending(null);
      callbacks.current.onSaved(document);
    } catch (error) {
      if (error instanceof ApiError && error.code !== "INVALID_RESPONSE" && error.status === 409) {
        setFailure({ kind: "conflict", message: "Instructions changed. Draft retained." }); setPending(null);
      } else if (error instanceof ApiError && error.code !== "INVALID_RESPONSE" && [400, 413].includes(error.status)) {
        setFailure({ kind: "rejected", message: error.message }); setPending(null);
      } else {
        // Includes failures after commit/worker propagation and authorization
        // loss during Retry. None proves that the original save did not happen.
        setFailure({ kind: "uncertain", message: errorMessage(error) });
      }
    } finally { inFlight.current = false; setSaving(false); }
  }
  function save() {
    if (!canSave || !base || inFlight.current) return;
    void submit({ requestId: crypto.randomUUID(), expectedRevision: base.revision, content: draftRef.current });
  }
  async function reviewLatest() {
    if (reviewing) return;
    reviewRequest.current?.abort();
    const controller = new AbortController(); reviewRequest.current = controller;
    setReviewOpen(true); setReviewing(true); setReviewError("");
    try {
      const result = await api<{ instructions: ProjectInstructionsDocument }>(path, undefined, controller.signal);
      if (!controller.signal.aborted) setLatest(checkedDocument(result.instructions, project.id));
    } catch (error) {
      if (!controller.signal.aborted) setReviewError(errorMessage(error));
    } finally { if (!controller.signal.aborted) setReviewing(false); }
  }
  function reconcile(replace: boolean) {
    if (!latest || pending || inFlight.current || reviewing || reviewError || reviewStale) return;
    if (replace && dirty && !window.confirm("Replace your local draft with the reviewed instructions?")) return;
    setBase(latest); setFailure(null); setReceipt(null); setReviewOpen(false);
    if (replace) replaceDraft(latest.content);
  }
  const status = pending ? "Draft retained" : failure?.kind === "conflict" ? "Draft retained"
    : dirty ? "Unsaved changes" : receipt ? `Save confirmed · revision ${receipt.revision}` : project.canManage ? "" : "Read-only";
  return <section className="project-spec-page project-instructions-page" aria-labelledby={`instructions-title-${project.id}`}>
    <a className="project-spec-back" href={`?${new URLSearchParams({ section: "projects", project: project.id })}`} onClick={event => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      event.preventDefault(); onBack();
    }}><ArrowLeft size={18} aria-hidden="true" />{project.name}</a>
    <header className="instructions-heading">
      <h1 id={`instructions-title-${project.id}`} ref={heading} tabIndex={-1}>Instructions</h1>
      {base && project.canManage ? <div className="instructions-actions">
        <Button variant="secondary" disabled={!dirty || saving || Boolean(pending)} onClick={discard}>Discard</Button>
        <Button disabled={!canSave} onClick={save}>{saving ? "Saving…" : "Save"}</Button>
      </div> : null}
      {base ? <div className="instructions-revision"><span>Saved revision {savedRevision}</span><span role="status" className="text-muted">{status}</span></div> : null}
    </header>
    {loading ? <Spinner label="Loading instructions" /> : null}
    {loadError ? <Notice>Instructions could not be loaded. {loadError} <Button variant="ghost" onClick={() => setLoadAttempt(value => value + 1)}>Retry</Button></Notice> : null}
    {base ? <>
      <div className="project-spec-toolbar">
        <div className="segmented-control" role="group" aria-label="Instructions view">
          <Button variant="ghost" aria-pressed={view === "preview"} onClick={() => setView("preview")}>Preview</Button>
          <Button variant="ghost" aria-pressed={view === "source"} onClick={() => { setSourceShown(true); setView("source"); }}>Source</Button>
        </div>
      </div>
      <div className="instructions-help">
        <p>Changes apply when agents are idle.</p>
        <details><summary>About instructions</summary><div>
          <p>Model-visible. No secrets.</p>
          <p>No permissions or assignments. Saving starts no work.</p>
          <p>Save empty to clear. History remains.</p>
          <p>Use Stop to interrupt agents.</p>
        </div></details>
      </div>
      {!project.canManage && needsRetention ? <Notice>Management permission unavailable. Draft retained.</Notice> : null}
      {failure ? <Notice>
        <strong>{failure.kind === "uncertain" ? "Save not confirmed" : failure.kind === "conflict" ? "Instructions changed. Draft retained." : "Save rejected"}</strong>
        <p>{failure.kind === "uncertain" ? "Draft retained. Retry resends the original save." : failure.kind === "conflict" ? "Review the latest instructions before saving again." : failure.message}</p>
        {failure.kind === "uncertain" ? <p>{failure.message}</p> : null}
        <div className="project-spec-recovery">
          {pending ? <Button disabled={saving || !project.canManage} onClick={() => void submit(pending)}>Retry</Button> : null}
          <Button variant={failure.kind === "conflict" ? "primary" : "secondary"} disabled={reviewing} onClick={() => void reviewLatest()}>Review latest</Button>
          <Button variant="ghost" onClick={() => void copyDraft()}>Copy draft</Button>
        </div>
      </Notice> : newer ? <Notice tone="info">A newer revision is saved. Draft based on revision {base.revision}. <Button variant="ghost" disabled={reviewing} onClick={() => void reviewLatest()}>Review latest</Button></Notice> : null}
      {reviewOpen ? <section className="instructions-review" aria-label="Latest saved instructions" aria-busy={reviewing}>
        <div className="instructions-review-heading"><h2>Latest saved{latest ? ` · revision ${latest.revision}` : ""}</h2><Button variant="ghost" onClick={() => setReviewOpen(false)}>Close review</Button></div>
        {reviewing ? <Spinner label="Reading latest instructions" /> : null}
        {reviewError ? <Notice>{reviewError}<Button variant="ghost" onClick={() => void reviewLatest()}>Retry read</Button></Notice> : null}
        {latest && !reviewing && !reviewError ? <>
          <div className="instructions-review-content">{latest.content ? <Markdown>{latest.content}</Markdown> : <p>No project instructions.</p>}</div>
          {pending ? <p>Retry the original save before reconciling. Reviewing does not confirm that save.</p>
            : reviewStale ? <p>A newer revision is saved. <Button variant="ghost" onClick={() => void reviewLatest()}>Refresh review</Button></p>
            : <p>Keep draft rebases the next save to revision {latest.revision}. Use latest replaces your draft.</p>}
          <div className="instructions-actions">
            <Button variant="secondary" disabled={Boolean(pending) || saving || reviewStale} onClick={() => reconcile(false)}>Keep draft</Button>
            <Button variant="secondary" disabled={Boolean(pending) || saving || reviewStale} onClick={() => reconcile(true)}>Use latest</Button>
          </div>
        </> : null}
      </section> : null}
      {copyStatus ? <p role="status">{copyStatus}</p> : null}
      {validation ? <p className="field-error" role="status">{validation}</p> : null}
      {view === "preview" ? <div className="project-spec-preview">{draft ? <Markdown>{draft}</Markdown> : <p className="text-muted">No project instructions.</p>}</div> : null}
      {sourceShown ? <div className="project-spec-source instructions-source" hidden={view !== "source"} inert={view !== "source"}>
        <Suspense fallback={<Spinner label="Loading editor" />}>
          <CodeEditor documentId={`${project.id}:instructions:${editorSession}`} path="instructions.md" initialValue={base.content}
            readOnly={!project.canManage} autoFocus={active && view === "source"} label={`Instructions Markdown${project.canManage ? "" : ", read-only"}`} onChange={changeDraft} />
        </Suspense>
      </div> : null}
    </> : null}
  </section>;
}
