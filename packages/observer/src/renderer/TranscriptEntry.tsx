import { useEffect, useState } from "react";
import {
  ArrowRight,
  Bot,
  ChevronRight,
  Terminal,
  UserRound,
} from "lucide-react";
import type { Activity } from "../shared/contracts";
import { UI } from "./controls";
import { time } from "./Details";
import {
  CodeBlock,
  MessageContent,
  outputPreview,
  ToolResult,
  ToolText,
} from "./Content";

export function TranscriptEntry({
  item,
  active,
  inspect,
}: {
  item: Activity;
  active: boolean;
  inspect(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    if (active) setExpanded(true);
  }, [active]);
  const metadata = (
    <small>
      Conversation {item.conversationId} ·{" "}
      {item.at ? time(item.at) : `Commit ${item.sequence}`}
    </small>
  );
  const inspectButton = (
    <UI.Button
      variant="link"
      size="sm"
      className="inspect-entry"
      onClick={inspect}
    >
      Inspect entry {item.entryId}
      <ArrowRight size={13} />
    </UI.Button>
  );
  if (item.tool) {
    const result = item.tool.phase === "result";
    return (
      <article
        data-event-id={item.id}
        className={`transcript-tool ${active ? "active" : ""}`}
      >
        <details
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary>
            <ChevronRight size={14} className="tool-chevron" />
            <Terminal size={15} />
            <span className="tool-heading">
              <span>
                <strong>{item.tool.name}</strong>
                <span
                  className={`tool-phase ${result && item.tool.error ? "tool-error" : ""}`}
                >
                  {result ? (item.tool.error ? "Error" : "Result") : "Called"}
                </span>
                {item.tool.truncated && result && (
                  <span className="tool-phase">Truncated</span>
                )}
              </span>
              {!expanded && (
                <span className="tool-preview">
                  {outputPreview(item.text) || "No saved text"}
                </span>
              )}
              {metadata}
            </span>
          </summary>
          {expanded && (
            <div className="tool-body">
              {result ? (
                <ToolResult activity={item} />
              ) : (
                <CodeBlock
                  text={JSON.stringify(item.tool.arguments ?? {}, null, 2)}
                  label="Tool arguments"
                />
              )}
              {result && item.tool.truncated && (
                <p className="notice">
                  The stored result reports omitted or truncated output.
                </p>
              )}
              {result && item.tool.durationMs !== undefined && (
                <p className="hint">
                  Reported duration: {item.tool.durationMs.toLocaleString()} ms
                </p>
              )}
              {inspectButton}
            </div>
          )}
        </details>
      </article>
    );
  }
  return (
    <article
      data-event-id={item.id}
      className={`transcript-entry ${item.role === "user" ? "user-entry" : ""} ${item.category === "boundary" ? "boundary-entry" : ""} ${active ? "active" : ""}`}
    >
      <header>
        <span>
          {item.role === "user" ? <UserRound size={16} /> : <Bot size={16} />}
          {item.role === "user"
            ? "You"
            : item.category === "boundary"
              ? "Context boundary"
              : item.category === "message"
                ? "Assistant"
                : item.title}
        </span>
        {metadata}
      </header>
      {item.category === "message" ? (
        <MessageContent text={item.text} />
      ) : (
        <ToolText text={item.text} />
      )}
      {inspectButton}
    </article>
  );
}
