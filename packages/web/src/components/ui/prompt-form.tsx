// Adapted from shadcn-ui/chatbot-template/components/prompt-form.tsx.
// Source revision, local adaptations and MIT license are recorded in NOTICE.md.
import { ArrowUp, FilePlus, ImagePlus, Paperclip, Square } from "lucide-react";
import { useRef, type ChangeEvent, type ReactNode } from "react";
import { AttachmentChip, type ComposerAttachment } from "./chat-patterns";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "./input-group";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "./overlays";

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
  const fileInput = useRef<HTMLInputElement>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const hasDraft = Boolean(value.trim() || attachments.length);
  const sendable =
    hasDraft &&
    !disabled &&
    attachments.every(
      (attachment) => !attachment.state || attachment.state === "ready",
    );

  function addSelectedFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.currentTarget.files ?? []);
    if (files.length && !disabled) onFiles?.(files);
    event.currentTarget.value = "";
  }

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
                disabled={disabled}
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
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (!onFiles || disabled || !files.length) return;
            event.preventDefault();
            onFiles(files);
          }}
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
                ref={fileInput}
                type="file"
                multiple
                hidden
                disabled={disabled}
                aria-label="Choose files"
                onChange={addSelectedFiles}
              />
              <input
                ref={photoInput}
                type="file"
                accept="image/*"
                multiple
                hidden
                disabled={disabled}
                aria-label="Choose photos"
                onChange={addSelectedFiles}
              />
              <Menu>
                <MenuTrigger
                  disabled={disabled}
                  render={
                    <InputGroupButton
                      size="icon-sm"
                      aria-label="Add attachments"
                    />
                  }
                >
                  <Paperclip />
                </MenuTrigger>
                <MenuContent side="top" align="start">
                  <MenuItem onClick={() => fileInput.current?.click()}>
                    <FilePlus className="size-4" />
                    Add files
                  </MenuItem>
                  <MenuItem onClick={() => photoInput.current?.click()}>
                    <ImagePlus className="size-4" />
                    Add photos
                  </MenuItem>
                </MenuContent>
              </Menu>
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
