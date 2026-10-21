import {
  Check,
  FileText,
  LoaderCircle,
  RotateCcw,
  Terminal,
  X,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
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
  file?: File;
}

function AttachmentPreview({ file }: { file?: File }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (
      !file ||
      !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(file.type)
    ) {
      setUrl(null);
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    setUrl(previewUrl);
    return () => URL.revokeObjectURL(previewUrl);
  }, [file]);

  return url ? (
    <img
      src={url}
      alt=""
      className="size-10 shrink-0 rounded-md bg-muted object-contain"
      onError={() => setUrl(null)}
    />
  ) : (
    <FileText aria-hidden="true" className="size-4 shrink-0 text-primary" />
  );
}

export function AttachmentChip({
  attachment,
  onRemove,
  onRetry,
  disabled = false,
}: {
  attachment: ComposerAttachment;
  onRemove?: () => void;
  onRetry?: () => void;
  disabled?: boolean;
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
        <AttachmentPreview file={attachment.file} />
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
          disabled={disabled}
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
          disabled={disabled}
        >
          <X />
        </Button>
      ) : null}
    </div>
  );
}
