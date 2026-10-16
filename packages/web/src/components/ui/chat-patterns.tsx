import {
  ArrowUp,
  Check,
  FileText,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  Square,
  Terminal,
  X,
} from "lucide-react";
import { useRef, type ReactNode } from "react";
import { Markdown } from "../markdown";
import type { MentionParticipant } from "../../lib/mentions";
import { Button } from "./button";
import { Bubble, BubbleContent } from "./bubble";
import {
  Message,
  MessageContent,
  MessageFooter,
  MessageHeader,
} from "./message";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./input-group";
import {
  Trace,
  TraceCollapsible,
  TraceCollapsibleContent,
  TraceCollapsibleTrigger,
  TraceIcon,
  TraceLine,
  TraceTitle,
} from "./trace";
import { cn } from "./utils";

export function MarkdownBody({
  children,
  format = "chat",
  mentions,
}: {
  children: string;
  format?: "chat" | "document";
  mentions?: MentionParticipant[];
}) {
  return (
    <Markdown
      className={cn(
        "typeset min-w-0",
        format === "chat" ? "typeset-chat" : "typeset-document",
      )}
      mentions={mentions}
    >
      {children}
    </Markdown>
  );
}

export function ChatMessage({
  author,
  kind,
  time,
  children,
  actions,
}: {
  author: string;
  kind: "person" | "agent";
  time?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <Message align={kind === "person" ? "end" : "start"}>
      <MessageContent>
        <MessageHeader className="gap-2 px-0">
          <span className="font-semibold text-foreground">{author}</span>
          {kind === "agent" ? <span>Agent</span> : null}
          {time ? <span>{time}</span> : null}
        </MessageHeader>
        <Bubble
          variant={kind === "person" ? "secondary" : "ghost"}
          className={
            kind === "person" ? "max-w-[92%] sm:max-w-[85%]" : "w-full"
          }
        >
          <BubbleContent className={kind === "person" ? "px-4 py-3" : "w-full"}>
            {children}
          </BubbleContent>
        </Bubble>
        {actions ? (
          <MessageFooter className="gap-1 px-0">{actions}</MessageFooter>
        ) : null}
      </MessageContent>
    </Message>
  );
}

export function ToolActivity({
  title,
  status,
  children,
}: {
  title: string;
  status: "pending" | "running" | "success" | "error";
  children: ReactNode;
}) {
  const Icon =
    status === "running"
      ? LoaderCircle
      : status === "success"
        ? Check
        : status === "error"
          ? X
          : Terminal;
  return (
    <Trace>
      <TraceCollapsible>
        <TraceCollapsibleTrigger>
          <TraceLine status={status === "success" ? undefined : status}>
            <TraceIcon>
              <Icon
                className={cn(
                  status === "running" && "animate-spin",
                  status === "success" && "text-success",
                )}
              />
            </TraceIcon>
            <TraceTitle>{title}</TraceTitle>
            <span className="sr-only"> · {status}</span>
          </TraceLine>
        </TraceCollapsibleTrigger>
        <TraceCollapsibleContent>
          <div className="text-sm">{children}</div>
        </TraceCollapsibleContent>
      </TraceCollapsible>
    </Trace>
  );
}

export interface ComposerAttachment {
  id: string;
  name: string;
  detail: string;
  state?: "ready" | "uploading" | "error";
}

export function AttachmentChip({
  attachment,
  onRemove,
  onRetry,
}: {
  attachment: ComposerAttachment;
  onRemove?: () => void;
  onRetry?: () => void;
}) {
  return (
    <div
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-2 rounded-lg border border-border bg-card py-1.5 pr-1.5 pl-3",
        attachment.state === "error" && "border-destructive/40",
      )}
    >
      {attachment.state === "uploading" ? (
        <LoaderCircle
          aria-hidden="true"
          className="size-4 shrink-0 animate-spin text-muted-foreground"
        />
      ) : (
        <FileText aria-hidden="true" className="size-4 shrink-0 text-primary" />
      )}
      <div className="min-w-0">
        <p className="truncate text-xs font-medium" title={attachment.name}>
          {attachment.name}
        </p>
        <p
          className={cn(
            "text-xs",
            attachment.state === "error"
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {attachment.state === "error" ? "Upload failed" : attachment.detail}
        </p>
      </div>
      {attachment.state === "error" && onRetry ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Retry ${attachment.name}`}
          onClick={onRetry}
        >
          <RotateCcw />
        </Button>
      ) : null}
      {onRemove ? (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Remove ${attachment.name}`}
          onClick={onRemove}
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}

// Adapted from the chatbot template's PromptForm. Dispatch keeps Send available
// during work when there is a draft; transport and draft ownership stay with the caller.
export function ChatComposer({
  value,
  onValueChange,
  onSend,
  onStop,
  running = false,
  disabled = false,
  attachments = [],
  onFiles,
  onRemoveAttachment,
  onRetryAttachment,
  leading,
}: {
  value: string;
  onValueChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
  running?: boolean;
  disabled?: boolean;
  attachments?: ComposerAttachment[];
  onFiles?: (files: File[]) => void;
  onRemoveAttachment?: (id: string) => void;
  onRetryAttachment?: (id: string) => void;
  leading?: ReactNode;
}) {
  const input = useRef<HTMLInputElement>(null);
  const hasDraft = Boolean(value.trim() || attachments.length);
  const sendable =
    hasDraft &&
    !disabled &&
    attachments.every(
      (attachment) => !attachment.state || attachment.state === "ready",
    );
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (sendable) onSend();
      }}
      className="w-full"
    >
      <InputGroup className="rounded-xl border-border bg-card shadow-sm">
        {attachments.length ? (
          <InputGroupAddon align="block-start" className="flex-wrap gap-2 p-3">
            {attachments.map((attachment) => (
              <AttachmentChip
                key={attachment.id}
                attachment={attachment}
                onRemove={
                  onRemoveAttachment
                    ? () => onRemoveAttachment(attachment.id)
                    : undefined
                }
                onRetry={
                  onRetryAttachment
                    ? () => onRetryAttachment(attachment.id)
                    : undefined
                }
              />
            ))}
          </InputGroupAddon>
        ) : null}
        <InputGroupTextarea
          aria-label="Message"
          placeholder="Write a message…"
          value={value}
          disabled={disabled}
          onChange={(event) => onValueChange(event.target.value)}
          className="min-h-24 max-h-60 px-4 py-4"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (sendable) onSend();
            }
          }}
        />
        <InputGroupAddon align="block-end" className="gap-2 px-3 pb-3">
          {onFiles ? (
            <>
              <input
                ref={input}
                type="file"
                multiple
                hidden
                aria-label="Choose attachments"
                onChange={(event) => {
                  onFiles(Array.from(event.currentTarget.files ?? []));
                  event.currentTarget.value = "";
                }}
              />
              <InputGroupButton
                size="icon-sm"
                aria-label="Attach files"
                disabled={disabled}
                onClick={() => input.current?.click()}
              >
                <Paperclip />
              </InputGroupButton>
            </>
          ) : null}
          {leading}
          <span className="flex-1" />
          {running && !hasDraft ? (
            <InputGroupButton
              size="icon-sm"
              variant="outline"
              aria-label="Stop generating"
              disabled={disabled}
              onClick={onStop}
            >
              <Square />
            </InputGroupButton>
          ) : (
            <InputGroupButton
              type="submit"
              size="icon-sm"
              variant="default"
              aria-label="Send message"
              disabled={!sendable}
            >
              <ArrowUp />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  );
}
