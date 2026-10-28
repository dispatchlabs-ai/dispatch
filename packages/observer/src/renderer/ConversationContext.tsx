import { useState } from "react";
import { ArrowRight, FileText } from "lucide-react";
import type { Conversation } from "../shared/contracts";
import { MessageContent } from "./Content";
import { UI } from "./controls";

export function instanceLabel(id: string) {
  const match = /^(.+):(\d+)$/.exec(id);
  return match
    ? `${match[1].replace(/[-_]/g, " ")} · conversation ${match[2]}`
    : id;
}

export function ConversationContext({
  conversation,
  conversations,
  onConversation,
  onRead,
  onSender,
  inWorkflow,
}: {
  conversation: Conversation;
  conversations: Conversation[];
  onConversation(id: number): void;
  onRead(): void;
  onSender?: () => void;
  inWorkflow: boolean;
}) {
  const [open, setOpen] = useState(false);
  const { opening, agent, channel, owner, parent } = conversation;
  const sender = opening?.sender;
  const labels = opening?.labels;
  const started = conversation.createdAt ?? opening?.at;
  const body = opening?.text.trimStart() ?? "";
  const brief = (
    labels
      ? body.replace(
          /^(?:(?:workflow|cycle|assignment|phase):[^\n]*(?:\n|$))+/i,
          "",
        )
      : body
  )
    .trim()
    .split(/\r?\n\s*\r?\n/)[0];
  const parentId = owner?.conversationId ?? parent?.conversationId;
  const parentConversation = conversations.find((item) => item.id === parentId);
  const title = sender
    ? sender.kind === "reply"
      ? "Opening reply"
      : "Original handoff"
    : "Opening request";
  return (
    <section className="conversation-context" aria-label="Assignment context">
      <header>
        <h2>{labels?.assignment ? "Assignment" : "Conversation context"}</h2>
        <span>
          {sender
            ? "Agent message"
            : channel
              ? `Started via ${channel}`
              : "Retained context"}
        </span>
      </header>
      <dl className="context-facts">
        <div>
          <dt>Agent</dt>
          <dd className="agent-name">
            {agent?.replace(/[-_]/g, " ") ?? "Not identified in this store"}
          </dd>
        </div>
        <div>
          <dt>
            {sender
              ? sender.kind === "reply"
                ? "Reply from"
                : "Sent by"
              : owner
                ? "Parent conversation"
                : "Started by"}
          </dt>
          <dd className="agent-name">
            {sender ? (
              onSender ? (
                <UI.Button
                  variant="link"
                  size="sm"
                  className="sender-link"
                  onClick={onSender}
                >
                  {instanceLabel(sender.from)}
                  <ArrowRight size={13} />
                </UI.Button>
              ) : (
                instanceLabel(sender.from)
              )
            ) : owner ? (
              `Conversation ${owner.conversationId}`
            ) : (
              "Caller not recorded"
            )}
          </dd>
          {sender && inWorkflow && !onSender && (
            <dd className="context-note">Sender conversation unavailable.</dd>
          )}
        </div>
        {started !== undefined && (
          <div>
            <dt>Started</dt>
            <dd>
              {new Date(started).toLocaleString(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              })}
            </dd>
          </div>
        )}
      </dl>
      {labels ? (
        <div className="handoff-labels">
          <h3>Declared in the handoff</h3>
          <dl className="context-facts">
            {Object.entries(labels).map(([key, value]) => (
              <div key={key}>
                <dt>{key === "phase" ? "Assigned phase" : key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        </div>
      ) : (
        <p className="context-note">
          {inWorkflow
            ? "Workflow linked through saved handoffs."
            : sender?.kind === "reply"
              ? "This opening message is a reply, not a new assignment."
              : "Workflow not identified in the opening message."}
        </p>
      )}
      {opening ? (
        <div className="handoff-preview">
          <header>
            <h3>{title}</h3>
            <UI.Button
              variant="outline"
              size="sm"
              onClick={() => {
                onRead();
                setOpen(true);
              }}
            >
              <FileText size={14} />
              Read full{" "}
              {sender?.kind === "message"
                ? "handoff"
                : sender
                  ? "reply"
                  : "request"}
            </UI.Button>
          </header>
          {brief && <p className="handoff-brief">{brief}</p>}
        </div>
      ) : (
        <p className="context-note">
          An opening request is not available in the retained first entry.
        </p>
      )}
      {parentId !== undefined ? (
        <UI.Button
          variant="link"
          size="sm"
          disabled={!parentConversation}
          onClick={() => onConversation(parentId)}
        >
          {owner ? "Parent conversation" : "Fork source"}:{" "}
          {parentConversation?.title ?? parentId}
          <ArrowRight size={14} />
        </UI.Button>
      ) : null}
      {open && opening && (
        <UI.Dialog open title={title} onOpenChange={setOpen}>
          <div className="handoff-content">
            {sender && (
              <p className="handoff-address">
                {instanceLabel(sender.from)} <ArrowRight size={14} />{" "}
                {instanceLabel(sender.to)}
              </p>
            )}
            {sender?.replyRequested && (
              <p className="context-note">
                The sender requested an automatic reply.
              </p>
            )}
            {sender && !owner && (
              <p className="context-note">
                Agent-to-agent message. No native parent conversation is
                recorded.
              </p>
            )}
            <p className="context-note">
              Original saved text · entry {opening.entryId}
              {labels
                ? " · workflow labels come from this message, not a native workflow/run link."
                : "."}
            </p>
            <MessageContent text={opening.text} />
          </div>
        </UI.Dialog>
      )}
    </section>
  );
}
