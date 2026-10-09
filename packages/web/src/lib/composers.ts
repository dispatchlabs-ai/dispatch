import { useRef, useState } from "react";
import type { ChatSnapshot, SendMessageInput } from "../shared/contracts";
import { ApiError, errorMessage } from "./api";
import { useAttachmentDrafts } from "./attachments";
import type { PendingMessage } from "./chat";
import { agentMentionPrefix } from "./mentions";
import { useSession } from "./session";

type Composer = {
  text: string;
  mentions: string[];
  version: number;
  pending?: PendingMessage;
  request?: { requestId: string; version: number };
  error?: string;
};
const emptyComposer: Composer = { text: "", mentions: [], version: 0 };
export const composerKey = (chatId: string, threadId?: string | null) => threadId ? `${chatId}:${threadId}` : chatId;

export function useComposers(onSnapshot: (snapshot: ChatSnapshot) => void) {
  const { api } = useSession();
  const [composers, setComposers] = useState<Record<string, Composer>>({});
  const current = useRef(composers);
  const get = (key: string) => current.current[key] ?? emptyComposer;
  function update(key: string, next: Composer) {
    current.current = { ...current.current, [key]: next };
    setComposers(current.current);
  }
  const attachments = useAttachmentDrafts(key => {
    const state = get(key);
    update(key, { ...state, version: state.version + 1, request: undefined, pending: undefined, error: undefined });
  });
  function keys(chatId: string) {
    return [...new Set([...Object.keys(current.current), ...Object.keys(attachments.drafts)])]
      .filter(key => key === chatId || key.startsWith(`${chatId}:`));
  }
  return {
    get,
    attachments,
    isDirty(chatId: string) {
      return keys(chatId).some(key => {
        const state = get(key);
        return Boolean(state.text.trim() || state.pending || state.mentions.length || attachments.drafts[key]?.length);
      });
    },
    close(chatId: string) {
      for (const key of keys(chatId)) {
        attachments.clear(key);
        update(key, { ...emptyComposer, version: get(key).version + 1 });
      }
    },
    changeMentions(key: string, mentions: string[]) {
      const state = get(key);
      update(key, { ...state, mentions, version: state.version + 1, request: undefined, pending: undefined });
    },
    changeText(key: string, text: string) {
      const state = get(key);
      const abandonRetry = state.pending && !state.pending.sending && state.pending.text !== text.trim();
      update(key, { ...state, text, version: state.version + 1, error: undefined,
        request: abandonRetry ? undefined : state.request, pending: abandonRetry ? undefined : state.pending });
    },
    async send(conversationId: string, threadId: string | null = null, mentions: string[] = []) {
      const key = composerKey(conversationId, threadId);
      const state = get(key);
      if (state.pending?.sending) return;
      const previous = state.pending;
      const text = previous?.text ?? state.text.trim();
      const files = attachments.drafts[key] ?? [];
      if (files.some(item => !item.attachment)) return;
      const attachmentIds = previous?.attachmentIds ?? files.map(item => item.attachment!.id);
      if (!text && !attachmentIds.length) return;
      const command: SendMessageInput = {
        attachmentIds, requestId: previous?.requestId || crypto.randomUUID(), text, threadId,
        mentions: previous?.mentions ?? mentions.filter(id => !id.startsWith(agentMentionPrefix)),
        agentMentions: previous?.agentMentions ?? mentions.filter(id => id.startsWith(agentMentionPrefix)).map(id => id.slice(agentMentionPrefix.length)),
      };
      const request = state.request?.requestId === command.requestId ? state.request : { requestId: command.requestId, version: state.version };
      update(key, { ...state, text: "", request, pending: { ...command, sending: true }, error: undefined });
      try {
        onSnapshot(await api<ChatSnapshot>(`/api/chats/${encodeURIComponent(conversationId)}/messages`, command));
        const latest = get(key);
        if (latest.request?.requestId !== command.requestId) return;
        // A later draft can have identical text; only the submitted edit may be cleared.
        const unchanged = latest.version === request.version;
        if (unchanged) attachments.clear(key);
        update(key, { ...latest, ...(unchanged ? { text: "", mentions: [] } : {}), request: undefined, pending: undefined, error: undefined });
      } catch (error) {
        const latest = get(key);
        if (latest.request?.requestId !== command.requestId) return;
        const message = errorMessage(error);
        // Restore only the submitted edit; never replace a newer draft.
        const restored = latest.version === request.version ? { ...latest, text: state.text } : latest;
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
          update(key, { ...restored, request: undefined, pending: undefined, error: message });
        } else {
          update(key, { ...restored, pending: { ...command, sending: false, error: message } });
        }
      }
    },
  };
}
