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
import { instanceLabel } from "./ConversationContext";
import {
  CodeBlock,
  MessageContent,
  outputPreview,
  ToolResult,
  ToolText,
} from "./Content";

export function toolTitle(item: Activity) {
  switch (item.tool?.name) {
    case "bash":
      return "Terminal command";
    case "read":
      return "Read file";
    case "write":
      return "Write file";
    case "edit":
      return "Edit file";
    case "message_agent":
      return "Agent handoff";
    case "message_status":
      return "Handoff status";
    default:
      return item.title.replace(/_/g, " ");
  }
}

export function TranscriptEntry({
  item,
  author,
  active,
  inspect,
  onRead,
}: {
  item: Activity;
  author?: string;
  active: boolean;
  inspect(): void;
  onRead(): void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [messageExpanded, setMessageExpanded] = useState(false);
  const longRequest = item.role === "user" && item.text.length > 600;
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
    const args = item.tool.arguments;
    const command =
      args &&
      typeof args === "object" &&
      "command" in args &&
      typeof args.command === "string"
        ? args.command
        : undefined;
    return (
      <article
        data-event-id={item.id}
        className={`transcript-tool ${active ? "active" : ""}`}
      >
        <details
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary onClick={onRead}>
            <ChevronRight size={14} className="tool-chevron" />
            <Terminal size={15} />
            <span className="tool-heading">
              <span>
                <strong>{toolTitle(item)}</strong>
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
                <>
                  {command !== undefined && (
                    <CodeBlock text={command} label="Command" />
                  )}
                  {command === undefined ? (
                    <CodeBlock
                      text={JSON.stringify(args ?? {}, null, 2)}
                      label="Tool arguments"
                    />
                  ) : (
                    <details className="argument-details">
                      <summary>All arguments</summary>
                      <CodeBlock
                        text={JSON.stringify(args, null, 2)}
                        label="Tool arguments"
                      />
                    </details>
                  )}
                </>
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
  if (item.category === "record")
    return (
      <details
        className="transcript-record"
        data-event-id={item.id}
        open={active || undefined}
      >
        <summary onClick={onRead}>Saved record · {item.title}</summary>
        <ToolText text={item.text} />
        {inspectButton}
      </details>
    );
  return (
    <article
      data-event-id={item.id}
      className={`transcript-entry ${item.role === "user" ? "user-entry" : ""} ${item.category === "boundary" ? "boundary-entry" : ""} ${active ? "active" : ""}`}
    >
      <header>
        <span>
          {item.role === "user" && !item.sender ? (
            <UserRound size={16} />
          ) : (
            <Bot size={16} />
          )}
          {item.sender
            ? `${item.sender.kind === "reply" ? "Reply" : "Message"} from ${instanceLabel(item.sender.from)}`
            : item.role === "user"
              ? "Request"
              : item.category === "boundary"
                ? "Context boundary"
                : item.category === "message"
                  ? (author ?? "Assistant")
                  : item.title}
        </span>
        {metadata}
      </header>
      {item.category === "message" ? (
        <>
          {longRequest && !messageExpanded ? (
            <p className="request-preview">{item.text.slice(0, 600)}…</p>
          ) : (
            <MessageContent text={item.text} />
          )}
          {longRequest && (
            <UI.Button
              variant="link"
              size="sm"
              onClick={() => {
                onRead();
                setMessageExpanded(!messageExpanded);
              }}
            >
              {messageExpanded ? "Show less" : "Read full message"}
            </UI.Button>
          )}
        </>
      ) : (
        <ToolText text={item.text} />
      )}
      {inspectButton}
    </article>
  );
}
