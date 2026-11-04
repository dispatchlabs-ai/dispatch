import { useEffect, useState } from "react";
import { Check, Copy, Terminal, TriangleAlert } from "lucide-react";
import { UI } from "./controls";
import { processTime as clock } from "./process-time";
import { CodeBlock, MessageContent, ToolResult } from "./Content";
import type { Activity } from "../shared/contracts";
import type {
  ProcessAgent,
  RecordedTurn,
  TurnEvent,
  TurnTranscript,
} from "../shared/processes";

export type TurnView = {
  transcript?: TurnTranscript;
  expanded: Set<string>;
  tools: Map<string, Activity>;
};
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export function ProcessTranscript({
  agent,
  turn,
  view,
  live,
}: {
  agent: ProcessAgent;
  turn: RecordedTurn;
  view: TurnView;
  live: boolean;
}) {
  const [transcript, setTranscript] = useState(view.transcript);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const read = async () => {
      try {
        const data = await window.observer.processTurn({
          sourceId: agent.sourceId,
          conversationId: agent.conversationId,
          entryId: turn.entryId,
        });
        if (!cancelled) {
          if (view.transcript?.sequence !== data.sequence) {
            view.transcript = data;
            setTranscript(data);
          }
          setError("");
        }
      } catch (error) {
        if (!cancelled) setError(errorText(error));
      } finally {
        if (!cancelled && live && turn.number === agent.turns)
          timer = setTimeout(read, 5000);
      }
    };
    void read();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [
    agent.sourceId,
    agent.conversationId,
    agent.turns,
    turn.entryId,
    turn.number,
    view,
    live,
    retry,
  ]);

  return (
    <section
      className="turn-transcript"
      aria-label={`Turn ${turn.number} transcript`}
    >
      {error && (
        <div role="status" className="process-notice">
          <span>
            {error}
            {transcript ? " Showing the last saved view." : ""}
          </span>
          <UI.Button
            variant="outline"
            size="sm"
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </UI.Button>
        </div>
      )}
      {!transcript && !error && (
        <p className="process-empty">Reading this turn…</p>
      )}
      {transcript?.events.map((event) =>
        event.tool ? (
          <ToolCall key={event.id} event={event} agent={agent} view={view} />
        ) : (
          <TranscriptMessage
            key={event.id}
            event={event}
            author={
              event.sender
                ? event.sender.from
                : event.role === "user"
                  ? agent.parentKey && turn.number === 1
                    ? "Assignment"
                    : "User"
                  : event.role === "assistant"
                    ? agent.name
                    : event.title
            }
            view={view}
          />
        ),
      )}
      {transcript && !transcript.events.length && (
        <p className="process-empty">
          No public message or tool activity was retained for this turn.
        </p>
      )}
      {turn.error && (
        <p className="transcript-error">
          <TriangleAlert className="size-4" />
          This assistant response was interrupted or ended with a recorded
          error.
        </p>
      )}
      {transcript && (
        <p className="transcript-end">End of turn {turn.number}</p>
      )}
    </section>
  );
}

function TranscriptMessage({
  event,
  author,
  view,
}: {
  event: TurnEvent;
  author: string;
  view: TurnView;
}) {
  const [open, setOpen] = useState(view.expanded.has(event.id));
  const long = event.role === "user" && event.text.length > 900;
  return (
    <UI.Message
      className={`transcript-message ${event.role === "user" ? "transcript-request" : ""}`}
    >
      <UI.MessageContent>
        <UI.MessageHeader className="transcript-message-header">
          <strong>{author}</strong>
          <time>{clock(event.at)}</time>
        </UI.MessageHeader>
        {long && !open ? (
          <p className="transcript-message-preview">
            {event.text.slice(0, 440).trimEnd()}…
          </p>
        ) : (
          <MessageContent text={event.text} />
        )}
        {long && (
          <UI.Button
            variant="ghost"
            size="sm"
            className="message-expand"
            aria-expanded={open}
            onClick={() => {
              if (open) view.expanded.delete(event.id);
              else view.expanded.add(event.id);
              setOpen(!open);
            }}
          >
            {open ? "Show less" : "Show full message"}
          </UI.Button>
        )}
      </UI.MessageContent>
    </UI.Message>
  );
}

function ToolCall({
  event,
  agent,
  view,
}: {
  event: TurnEvent;
  agent: ProcessAgent;
  view: TurnView;
}) {
  const [open, setOpen] = useState(view.expanded.has(event.id));
  const [detail, setDetail] = useState(view.tools.get(event.id));
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [copied, setCopied] = useState(false);
  const tool = event.tool!;
  useEffect(() => {
    if (
      !open ||
      (detail && Boolean(detail.tool?.result) === event.hasResult && !retry)
    )
      return;
    let cancelled = false;
    void window.observer
      .processTool({
        sourceId: agent.sourceId,
        conversationId: agent.conversationId,
        entryId: event.entryId,
        callId: tool.callId,
      })
      .then((value) => {
        if (!cancelled) {
          view.tools.set(event.id, value);
          setDetail(value);
          setError("");
        }
      })
      .catch((error) => {
        if (!cancelled) setError(errorText(error));
      });
    return () => {
      cancelled = true;
    };
  }, [
    open,
    event.id,
    event.hasResult,
    event.entryId,
    agent.sourceId,
    agent.conversationId,
    tool.callId,
    retry,
    view,
  ]);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(timer);
  }, [copied]);
  const status = tool.error
    ? "Error"
    : event.hasResult
      ? "Result saved"
      : "No result saved";
  const duration =
    tool.durationMs === undefined
      ? undefined
      : tool.durationMs < 1000
        ? `${tool.durationMs} ms`
        : `${(tool.durationMs / 1000).toFixed(1)} s`;
  return (
    <UI.Trace className="transcript-tool">
      <UI.TraceCollapsible
        open={open}
        onOpenChange={(value) => {
          if (value) view.expanded.add(event.id);
          else view.expanded.delete(event.id);
          setOpen(value);
        }}
      >
        <UI.TraceCollapsibleTrigger className="transcript-tool-trigger">
          <UI.TraceLine status={tool.error ? "error" : undefined}>
            <UI.TraceIcon>
              {tool.error ? <TriangleAlert /> : <Terminal />}
            </UI.TraceIcon>
            <UI.TraceTitle>{event.title}</UI.TraceTitle>
          </UI.TraceLine>
          <UI.TraceDescription className="transcript-tool-status">
            {duration && <span>{duration}</span>}
            {status}
          </UI.TraceDescription>
        </UI.TraceCollapsibleTrigger>
        <UI.TraceCollapsibleContent className="transcript-tool-body">
          {error && (
            <div role="status" className="process-notice">
              {error}
              <UI.Button
                variant="outline"
                size="sm"
                onClick={() => setRetry((value) => value + 1)}
              >
                Retry
              </UI.Button>
            </div>
          )}
          {!detail && !error && (
            <p className="secondary">Loading saved tool data…</p>
          )}
          {detail && (
            <>
              <div className="tool-detail-heading">
                <span>{tool.name}</span>
                <UI.Button
                  variant="ghost"
                  size="sm"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(
                        JSON.stringify(
                          {
                            arguments: detail.tool?.arguments,
                            result: detail.tool?.result,
                          },
                          null,
                          2,
                        ),
                      );
                      setCopied(true);
                    } catch (error) {
                      setError(errorText(error));
                    }
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                  {copied ? "Copied" : "Copy"}
                </UI.Button>
              </div>
              {detail.tool?.arguments !== undefined && (
                <section>
                  <h3>Arguments</h3>
                  <CodeBlock
                    text={JSON.stringify(detail.tool.arguments, null, 2)}
                    label="Tool arguments"
                  />
                </section>
              )}
              <section>
                <h3>
                  {tool.error ? "Error result" : "Result"}
                  {event.resultAt && <time>{clock(event.resultAt)}</time>}
                </h3>
                {detail.tool?.result ? (
                  <ToolResult activity={detail} />
                ) : (
                  <p className="secondary">
                    No matching result has been saved.
                  </p>
                )}
              </section>
              {detail.tool?.truncated && (
                <p className="tool-evidence-note">
                  This result was truncated in the saved record.
                </p>
              )}
            </>
          )}
        </UI.TraceCollapsibleContent>
      </UI.TraceCollapsible>
    </UI.Trace>
  );
}
