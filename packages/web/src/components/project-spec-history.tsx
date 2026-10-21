import { lazy, Suspense, useEffect, useState } from "react";
import type { ProjectMarkdownDocument, ProjectSpecRevision, ProjectSpecRevisionPage } from "../shared/contracts";
import { errorMessage } from "../lib/api";
import { useSession } from "../lib/session";
import { Markdown } from "./markdown";
import { Button, Notice, Spinner, RevisionPicker, RevisionHistorySurface } from "./ui";

const FileDiff = lazy(() => import("./file-diff"));

/** Isolated from the current editor and its save/retry session. */
export function ProjectSpecHistory({ projectId }: { projectId: string }) {
  const { api } = useSession();
  const [revisions, setRevisions] = useState<ProjectSpecRevision[]>([]);
  const [nextBefore, setNextBefore] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number>();
  const [listAttempt, setListAttempt] = useState(0);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState("");
  const [from, setFrom] = useState(0);
  const [to, setTo] = useState(0);
  const [compare, setCompare] = useState(false);
  const [bodies, setBodies] = useState<ProjectMarkdownDocument[] | null>(null);
  const [readError, setReadError] = useState("");
  const [readAttempt, setReadAttempt] = useState(0);
  const base = `/api/projects/${encodeURIComponent(projectId)}/spec`;

  useEffect(() => {
    const controller = new AbortController();
    setListLoading(true); setListError("");
    void api<ProjectSpecRevisionPage>(`${base}/revisions${cursor === undefined ? "" : `?before=${cursor}`}`, undefined, controller.signal).then(page => {
      if (controller.signal.aborted) return;
      setRevisions(previous => cursor === undefined ? page.revisions : [...previous, ...page.revisions]);
      setNextBefore(page.nextBefore); setListLoading(false);
      if (cursor === undefined) {
        setFrom(page.revisions[1]?.revision ?? page.revisions[0]?.revision ?? 0);
        setTo(page.revisions[0]?.revision ?? 0);
      }
    }).catch(error => { if (!controller.signal.aborted) { setListError(errorMessage(error)); setListLoading(false); } });
    return () => controller.abort();
  }, [api, base, cursor, listAttempt]);

  useEffect(() => {
    const controller = new AbortController();
    setBodies(null); setReadError("");
    if (!to) return () => controller.abort();
    const selected = compare && from !== to ? [from, to] : [to];
    void Promise.all(selected.map(async revision => {
      const { spec } = await api<{ spec: ProjectMarkdownDocument }>(`${base}?revision=${revision}`, undefined, controller.signal);
      if (spec.projectId !== projectId || spec.revision !== revision) throw new Error("Unexpected spec revision response");
      return spec;
    })).then(result => { if (!controller.signal.aborted) setBodies(result); }).catch(error => { if (!controller.signal.aborted) setReadError(errorMessage(error)); });
    return () => controller.abort();
  }, [api, base, projectId, from, to, compare, readAttempt]);

  // Hide old responses immediately on selection changes, before effects run.
  const selected = compare && from !== to ? [from, to] : [to];
  const ready = bodies && bodies.length === selected.length && bodies.every((body, index) => body.revision === selected[index]);
  const before = ready ? bodies[0] : null;
  const after = ready ? bodies.at(-1)! : null;
  return <RevisionHistorySurface>
    <h2>Saved revisions</h2>
    <p>Read-only · current drafts are not included.</p>
    {listLoading ? <Spinner label="Loading revisions" /> : null}
    {listError ? <Notice>{listError} <Button variant="ghost" onClick={() => setListAttempt(value => value + 1)}>Retry revisions</Button></Notice> : null}
    {!listLoading && !listError && !revisions.length ? <Notice tone="info">No saved revisions yet.</Notice> : null}
    {revisions.length ? <>
      <div className="project-spec-toolbar">
        <Button variant="secondary" aria-pressed={!compare} onClick={() => setCompare(false)}>Read revision</Button>
        <Button variant="secondary" aria-pressed={compare} onClick={() => setCompare(true)}>Compare revisions</Button>
        {nextBefore !== null ? <Button variant="ghost" disabled={listLoading} onClick={() => setCursor(nextBefore)}>Load older revisions</Button> : null}
      </div>
      {compare ? <RevisionPicker label="From revision" value={from} revisions={revisions.map(item => item.revision)} onChange={setFrom} /> : null}
      <RevisionPicker label={compare ? "To revision" : "Revision"} value={to} revisions={revisions.map(item => item.revision)} onChange={setTo} />
      {readError ? <Notice>{readError} <Button variant="ghost" onClick={() => setReadAttempt(value => value + 1)}>Retry revision</Button></Notice> : !ready ? <Spinner label="Loading saved spec" /> : null}
      {ready && before && after ? <>
        {compare ? <><h3>Revision {from} → Revision {to}</h3><RevisionMetadata revision={before} /></> : null}
        {(!compare || from !== to) ? <RevisionMetadata revision={after} /> : null}
        {compare ? before.content === after.content ? <Notice tone="info">No changes between these saved revisions.{!after.content ? " Both are empty." : ""}</Notice> : <>
          <p>− Removed from revision {from} · + Added in revision {to} · surrounding unchanged context</p>
          <Suspense fallback={<Spinner label="Loading comparison" />}><FileDiff kind="compare" path="spec.md" before={before.content} after={after.content} /></Suspense>
        </> : after.content ? <div className="project-spec-preview"><Markdown>{after.content}</Markdown></div> : <Notice tone="info">This saved revision is empty.</Notice>}
      </> : null}
    </> : null}
  </RevisionHistorySurface>;
}

function RevisionMetadata({ revision }: { revision: ProjectSpecRevision }) {
  return <details>
    <summary>Revision {revision.revision}{revision.savedAt !== undefined ? ` · ${new Date(revision.savedAt).toLocaleString()}` : ""}</summary>
    <dl>
      {revision.savedBy ? <><dt>Saved by</dt><dd>{revision.savedBy}</dd></> : null}
      <dt>Content hash</dt><dd><code>{revision.contentHash}</code></dd>
      {revision.importedFrom ? <><dt>Imported from</dt><dd>{revision.importedFrom.source} · {revision.importedFrom.url} · {revision.importedFrom.path} · {revision.importedFrom.version}</dd></> : null}
    </dl>
  </details>;
}
