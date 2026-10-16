// Adapted from shadcn-ui/chatbot-template/components/prompt-form.tsx.
// Source revision, local adaptations and MIT license are recorded in NOTICE.md.
import { ArrowUp, Paperclip, Square } from "lucide-react";
import { useRef, type ReactNode } from "react";
import { AttachmentChip, type ComposerAttachment } from "./chat-patterns";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./input-group";

// Dispatch allows another message during work; draft and transport ownership stay with the caller.
export function PromptForm({
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
              variant="default"
              className="rounded-full"
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
              className="rounded-full"
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
