import { ExternalLink, FileText, Terminal, X } from "lucide-react";
import { useEffect, useRef, useState, type Ref } from "react";
import { UI } from "./controls";
import type { Activity, Task, Document, Snapshot } from "../shared/contracts";
import { MessageContent, ToolResult } from "./Content";
import { Transcript } from "./Transcript";

export type Selection =
  | { kind: "activity"; value: Activity }
  | { kind: "task"; value: Task }
  | { kind: "document"; value: Document };
export type EvidenceView = {
  title: string;
  snapshot?: Snapshot;
  error?: string;
};
export const pretty = (value: unknown) =>
  typeof value === "string" ? value : JSON.stringify(value, null, 2);
export const time = (value?: number) =>
  value !== undefined
    ? new Date(value).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "Time not retained";
export function Badge({ value }: { value: string }) {
  return (
    <span
      className={`badge ${/running|pending|live|following/.test(value) ? "blue" : /wait|completing/.test(value) ? "amber" : /fail|fault|error|abort|disconnect/.test(value) ? "red" : /success|completed|terminal|connected/.test(value) ? "green" : ""}`}
    >
      <span />
      {value}
    </span>
  );
}
function Code({ value }: { value: unknown }) {
  return <pre tabIndex={0}>{pretty(value)}</pre>;
}
type DetailsProps = {
  selection?: Selection;
  evidence?: EvidenceView;
  close(): void;
  historical: boolean;
  resizer: React.ReactNode;
  controls?: React.ReactNode;
};
export function Details(props: DetailsProps) {
  const panel = useRef<HTMLElement>(null);
  const evidenceOpener = useRef<HTMLElement | null>(null);
  const [narrow, setNarrow] = useState(
    () => matchMedia("(max-width:1180px)").matches,
  );
  useEffect(() => {
    const media = matchMedia("(max-width:1180px)");
    const change = () => setNarrow(media.matches);
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);
  const hasEvidence = Boolean(props.evidence);
  useEffect(() => {
    if (narrow || !hasEvidence) return;
    evidenceOpener.current = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
  }, [hasEvidence, narrow]);
  const closeEvidence = () => {
    props.close();
    if (!narrow && evidenceOpener.current?.isConnected)
      evidenceOpener.current.focus({ preventScroll: true });
  };
  const content = props.evidence ? (
    <EvidencePanel
      evidence={props.evidence}
      close={closeEvidence}
      resizer={props.resizer}
      panelRef={panel}
    />
  ) : (
    <DetailPanel {...props} />
  );
  if (narrow && (props.selection || props.evidence)) {
    const title =
      props.evidence?.title ??
      (props.selection!.kind === "activity"
        ? props.selection!.value.title
        : props.selection!.value.kind);
    return (
      <UI.Dialog
        open
        title={title}
        side="right"
        onOpenChange={(open) => {
          if (!open) props.close();
        }}
      >
        <div className="detail-content">{content}</div>
        {!props.evidence && props.selection?.kind === "activity" && (
          <div className="mobile-playback">{props.controls}</div>
        )}
      </UI.Dialog>
    );
  }
  return content;
}

function EvidencePanel({
  evidence,
  close,
  resizer,
  panelRef,
}: {
  evidence: EvidenceView;
  close(): void;
  resizer: React.ReactNode;
  panelRef: Ref<HTMLElement>;
}) {
  return (
    <aside
      className="detail-panel evidence-panel"
      aria-label="Saved evidence"
      tabIndex={-1}
      ref={panelRef}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          close();
        }
      }}
    >
      {resizer}
      <div className="detail-heading">
        <div>
          <p className="eyebrow">Saved evidence</p>
          <h2>
            {evidence.error
              ? "Referenced evidence unavailable"
              : evidence.title}
          </h2>
        </div>
        <UI.Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close evidence"
          onClick={close}
        >
          <X />
        </UI.Button>
      </div>
      <p className="hint">Latest observation · playback unchanged</p>
      {evidence.error ? (
        <p role="alert" className="notice">
          {evidence.error}
        </p>
      ) : evidence.snapshot ? (
        <Transcript
          events={evidence.snapshot.activities}
          conversations={evidence.snapshot.conversations}
          expanded
          onRead={() => {}}
        />
      ) : (
        <p className="notice" role="status">
          Reading saved entry…
        </p>
      )}
      <UI.Button variant="outline" size="sm" onClick={close}>
        Return to conversation
      </UI.Button>
    </aside>
  );
}
function DetailPanel({
  selection,
  close,
  historical,
  resizer,
}: DetailsProps) {
  if (!selection)
    return (
      <aside className="detail-panel empty-detail">
        {resizer}
        <FileText size={28} strokeWidth={1.3} />
        <h3>A closer look</h3>
        <p>
          Select an event, task, or document to inspect the saved evidence.
        </p>
      </aside>
    );
  const item = selection.value;
  const title =
    selection.kind === "activity"
      ? selection.value.title
      : selection.value.kind;
  const links = [
    ...new Set(
      pretty(selection.value).match(/https?:\/\/[^\s"<>\\]+/g) ?? [],
    ),
  ].filter((url) => {
    try {
      const parsed = new URL(url);
      return !parsed.username && !parsed.password;
    } catch {
      return false;
    }
  });
  return (
    <aside className="detail-panel" aria-label="Selected record details">
      {resizer}
      <div className="detail-heading">
        <div>
          <p className="eyebrow">
            {selection.kind === "activity"
              ? `ENTRY ${selection.value.entryId}`
              : `${selection.kind} ${item.id}`}
          </p>
          <h2>{title}</h2>
        </div>
        <UI.Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close details"
          onClick={close}
        >
          <X />
        </UI.Button>
      </div>
      {selection.kind === "activity" ? (
        <>
          <div className="detail-meta">
            <span>{time(selection.value.at)}</span>
            <span>Conversation {selection.value.conversationId}</span>
          </div>
          {selection.value.inherited && (
            <p className="notice">
              Inherited from the recorded fork ancestry.
            </p>
          )}
          {selection.value.tool ? (
            <>
              <section className="detail-card">
                <h3>
                  <Terminal size={16} />
                  {selection.value.tool.name}
                  <Badge
                    value={
                      selection.value.tool.live?.status ??
                      (selection.value.tool.phase === "result" &&
                      selection.value.tool.error
                        ? "error"
                        : selection.value.tool.missing
                          ? "result unavailable"
                          : "recorded")
                    }
                  />
                </h3>
                <p className="hint">Call {selection.value.tool.callId}</p>
                {selection.value.tool.arguments !== undefined && (
                  <>
                    <h4>Requested arguments</h4>
                    <Code value={selection.value.tool.arguments} />
                  </>
                )}
                {selection.value.tool.live && (
                  <>
                    <h4>Latest retained live slot</h4>
                    <Code value={selection.value.tool.live} />
                    <p className="hint">
                      This is the last observed slot, separate from the
                      playback cursor.
                    </p>
                  </>
                )}
                {selection.value.tool.result !== undefined && (
                  <>
                    <h4>
                      {selection.value.tool.phase === "call"
                        ? "Matching result · recorded later"
                        : "Result"}
                    </h4>
                    <ToolResult activity={selection.value} />
                  </>
                )}
                {selection.value.tool.missing && (
                  <p className="notice">
                    No matching result in the loaded records.
                    {selection.value.tool.live
                      ? " Its latest live slot is shown above."
                      : " The call may still be running, or its result may be outside this page."}
                  </p>
                )}
                {selection.value.tool.durationMs !== undefined && (
                  <p className="hint">
                    Reported duration:{" "}
                    {selection.value.tool.durationMs.toLocaleString()} ms
                  </p>
                )}
                {selection.value.tool.truncated && (
                  <p className="notice">
                    The stored result reports omitted or truncated output.
                  </p>
                )}
              </section>
            </>
          ) : (
            <section className="detail-card">
              <h3>
                {selection.value.category === "boundary"
                  ? "Context boundary"
                  : "Saved content"}
              </h3>
              <MessageContent text={selection.value.text} />
            </section>
          )}
          <p className="hint">
            Commit {selection.value.sequence}
            {selection.value.taskId
              ? ` · Task ${selection.value.taskId}`
              : ""}
            . Saved transcript content is not the exact provider request.
          </p>
          <details className="detail-card">
            <summary>Native entry record</summary>
            <Code value={selection.value.record} />
          </details>
        </>
      ) : selection.kind === "task" ? (
        <>
          <p className="notice">
            {historical
              ? "Current/final task state, separate from the playback cursor."
              : "Last observed task state. Runtime presence is not independently confirmed."}
          </p>
          <Badge value={selection.value.outcome ?? selection.value.status} />
          <dl>
            <dt>Scheduling state</dt>
            <dd>{selection.value.status}</dd>
            <dt>Conversation</dt>
            <dd>{selection.value.conversationId}</dd>
            <dt>Owning task</dt>
            <dd>{selection.value.owner ?? "Conversation-owned"}</dd>
            <dt>Started</dt>
            <dd>{time(selection.value.startedAt)}</dd>
            <dt>Ended</dt>
            <dd>{time(selection.value.endedAt)}</dd>
            {selection.value.phase && (
              <>
                <dt>Saved phase</dt>
                <dd>{selection.value.phase}</dd>
              </>
            )}
            {selection.value.attempt !== undefined && (
              <>
                <dt>Saved attempt</dt>
                <dd>{selection.value.attempt}</dd>
              </>
            )}
            {selection.value.waitingOn.length > 0 && (
              <>
                <dt>Waiting on tasks</dt>
                <dd>{selection.value.waitingOn.join(", ")}</dd>
              </>
            )}
          </dl>
          <section className="detail-card">
            <h3>Native task record</h3>
            <Code value={selection.value.record} />
          </section>
        </>
      ) : (
        <>
          <p className="notice">
            Latest retained document. Historical intermediate phases may not
            have been saved.
          </p>
          {selection.value.unavailable ? (
            <p className="error-message">{selection.value.unavailable}</p>
          ) : (
            <section className="detail-card">
              <h3>Saved document</h3>
              <Code value={selection.value.value} />
            </section>
          )}
          <p className="hint">
            {selection.value.history
              ? `History: ${selection.value.history}. `
              : ""}
            {selection.value.sequence
              ? `Revision at commit ${selection.value.sequence}.`
              : ""}
          </p>
        </>
      )}
      {links.length > 0 && (
        <section className="detail-card">
          <h3>Recorded links</h3>
          {links.map((url) => (
            <UI.Button
              key={url}
              variant="link"
              className="record-link"
              onClick={() => void window.observer.external(url)}
            >
              <ExternalLink size={13} />
              {url}
            </UI.Button>
          ))}
        </section>
      )}
      <p className="hint">
        Known credential fields are redacted; arbitrary saved text can still
        contain sensitive content.
      </p>
    </aside>
  );
}
