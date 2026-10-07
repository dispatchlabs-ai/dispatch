import { useEffect, useRef, useState } from "react";
import { errorMessage } from "./api";
import { useSession } from "./session";

import { ATTACHMENT_MAX_BYTES, ATTACHMENT_TOTAL_MAX_BYTES, ATTACHMENT_MAX_COUNT, type Attachment } from "../shared/contracts";

export interface DraftAttachment { id: string; file: File; attachment?: Attachment; error?: string }
export const emptyAttachments: DraftAttachment[] = [];

export function useAttachmentDrafts(onEdit: (key: string) => void) {
  const { api } = useSession();
  const [drafts, setDrafts] = useState<Record<string, DraftAttachment[]>>({});
  const current = useRef(drafts);
  const uploads = useRef(new Map<string, AbortController>());
  function update(key: string, items: DraftAttachment[]) {
    current.current = { ...current.current, [key]: items };
    setDrafts(current.current);
  }
  useEffect(() => () => { for (const controller of uploads.current.values()) controller.abort(); }, []);
  async function upload(key: string, conversationId: string, item: DraftAttachment) {
    const controller = new AbortController();
    uploads.current.set(item.id, controller);
    const body = new FormData();
    body.append("file", item.file);
    try {
      const { attachment } = await api<{ attachment: Attachment }>(`/api/chats/${encodeURIComponent(conversationId)}/attachments`, body, controller.signal);
      if (!controller.signal.aborted) update(key, (current.current[key] ?? []).map(value => value.id === item.id ? { ...value, attachment, error: undefined } : value));
    } catch (error) {
      if (!controller.signal.aborted) update(key, (current.current[key] ?? []).map(value => value.id === item.id ? { ...value, error: errorMessage(error) } : value));
    } finally { uploads.current.delete(item.id); }
  }
  return {
    drafts,
    add(key: string, conversationId: string, files: File[]): string | undefined {
      if (!files.length) return;
      const existing = current.current[key] ?? [];
      if (existing.length + files.length > ATTACHMENT_MAX_COUNT) return "Attach up to 10 files per message.";
      if (files.some(file => file.size > ATTACHMENT_MAX_BYTES)) return "Each file must be 10 MiB or smaller.";
      if ([...existing.map(item => item.file), ...files].reduce((sum, file) => sum + file.size, 0) > ATTACHMENT_TOTAL_MAX_BYTES) return "Attachments must total 25 MiB or less.";
      const items = files.map(file => ({ id: crypto.randomUUID(), file }));
      onEdit(key);
      update(key, [...existing, ...items]);
      for (const item of items) void upload(key, conversationId, item);
    },
    remove(key: string, id: string) {
      uploads.current.get(id)?.abort();
      onEdit(key);
      update(key, (current.current[key] ?? []).filter(item => item.id !== id));
    },
    retry(key: string, conversationId: string, id: string) {
      const item = current.current[key]?.find(item => item.id === id);
      if (!item || uploads.current.has(id)) return;
      update(key, current.current[key].map(value => value.id === id ? { ...value, error: undefined } : value));
      void upload(key, conversationId, item);
    },
    clear(key: string) {
      for (const item of current.current[key] ?? []) uploads.current.get(item.id)?.abort();
      update(key, []);
    },
  };
}
