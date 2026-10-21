import { createHash } from "node:crypto";
import type { ConversationId, EntryRecord, LiveState } from "@earendil-works/pi-durable";
import type { Attachment, ConversationMessage, ParticipantActivity } from "../src/shared/contracts.js";
import { ATTACHMENT_IMAGE_MAX_BYTES } from "../src/shared/contracts.js";
import { attachmentMetadata, type StoredAttachment } from "./attachments.js";
import { activityPage, transcriptPage } from "./chat-pages.js";
import { CollaborationError, publicHistoryGeneration, projectMessages, projectActivityGroups, overlayLiveActivity, type SharedState } from "./collaboration/shared.js";
import { chatSourceUrl, type ProjectChatMetadata, type ProjectChatReadInput, type ProjectChatResult } from "./project-chat-context.js";

/** The caller authorizes the project first. Sources may be a local commit or a
 * read-only worker-store snapshot; neither projection starts/resumes execution. */
export type ProjectChatSource = {
  room: SharedState;
  entries(id: ConversationId): Promise<EntryRecord[]>;
  live(id: ConversationId): Promise<LiveState>;
  attachments(): Promise<Record<string, StoredAttachment>>;
  bytes(attachment: Attachment): Promise<Buffer>;
};
export async function readProjectChat(source: ProjectChatSource, roomId: ConversationId, metadata: ProjectChatMetadata, input: ProjectChatReadInput): Promise<ProjectChatResult> {
  const base = { chatId: metadata.id, url: chatSourceUrl(metadata.id) };
  const records = input.activityId ? {} : await source.attachments();
  const publicAttachment = (id: string) => records[id] && !records[id].private ? attachmentMetadata(records[id]) : undefined;
  const safeMessage = (message: ConversationMessage) => {
    const { images, attachments, ...rest } = message;
    return { ...rest, ...(images?.length ? { imageCount: images.length } : {}),
      ...(attachments?.length ? { attachments: attachments.flatMap(item => publicAttachment(item.id) ?? []) } : {}) };
  };
  const start = input.offset ?? 0;
  if (input.attachmentId) {
    const attachment = publicAttachment(input.attachmentId);
    if (!attachment) throw new CollaborationError(404, "Public item not found.");
    if (attachment.kind === "file") return { data: { ...base, attachment, readable: false, reason: "Download-only format; content is not extracted." } };
    if (attachment.kind === "image") {
      if (attachment.size > ATTACHMENT_IMAGE_MAX_BYTES) return { data: { ...base, attachment, readable: false, reason: "Image exceeds the 4 MiB model-input limit; original remains downloadable." } };
      return { data: { ...base, attachment }, images: [{ mimeType: attachment.mimeType, data: (await source.bytes(attachment)).toString("base64") }] };
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(await source.bytes(attachment));
    return { data: { ...base, attachment, text: text.slice(start, start + 12000), offset: start, textLength: text.length, nextOffset: start + 12000 < text.length ? start + 12000 : null } };
  }
  const roomEntries = await source.entries(roomId);
  const messages = projectMessages(roomEntries, source.room.messageAliases);
  if (input.messageId) {
    const message = messages.find(item => item.id === input.messageId || item.aliases?.includes(input.messageId!));
    if (!message) throw new CollaborationError(404, "Public item not found.");
    return { data: { ...base, message: { ...safeMessage(message), text: message.text.slice(start, start + 12000), textLength: message.text.length, offset: start, nextOffset: start + 12000 < message.text.length ? start + 12000 : null } } };
  }
  // Default pages read the public log only. Native activity is projected on an
  // explicit detail request, never scanned for every agent on every history page.
  const activities: ParticipantActivity[] = [];
  if (input.activityId || input.includeActivity) for (const member of source.room.members) {
    if (!member.conversationId || (input.activityId && !input.activityId.startsWith(`${member.id}:`))) continue;
    const entries = await source.entries(member.conversationId);
    const groups = projectActivityGroups(member, entries, messages);
    const projected = overlayLiveActivity(groups, await source.live(member.conversationId));
    if (input.activityId) {
      const activity = projected.find(item => item.id === input.activityId) ?? groups.find(item => item.id === input.activityId);
      if (!activity) throw new CollaborationError(404, "Public item not found.");
      return { data: { ...base, observation: "stored", activityId: activity.id, participantId: activity.participantId, threadId: activity.threadId, ...activityPage(activity, input.offset) } };
    }
    activities.push(...projected);
  }
  if (input.activityId) throw new CollaborationError(404, "Public item not found.");
  const generation = createHash("sha256").update(JSON.stringify([metadata.id, Boolean(input.includeActivity), publicHistoryGeneration(roomEntries, source.room.messageAliases)])).digest("hex");
  const page = transcriptPage(messages.map(safeMessage), activities, { before: input.before, threadId: input.threadId }, generation);
  // Criteria can be arbitrarily long: keep the result bounded and identify truncation.
  const criteria = source.room.definitionOfDone?.markdown ?? "";
  const criteriaOffset = input.criteriaOffset ?? 0;
  // The publication watermark serves live browser catch-up, not agents' bounded reads.
  const { publication: _publication, ...history } = page;
  return { data: { ...base, ...(input.includeActivity ? { activityObservation: "stored" } : {}), conversation: metadata,
    definitionOfDone: { markdown: criteria.slice(criteriaOffset, criteriaOffset + 12000), revision: source.room.definitionOfDone?.revision ?? 0,
      offset: criteriaOffset, textLength: criteria.length, nextOffset: criteriaOffset + 12000 < criteria.length ? criteriaOffset + 12000 : null },
    participants: source.room.members.map(member => ({ id: member.id, kind: member.kind, name: member.name,
      ...(member.kind === "agent" ? { membership: member.membership ?? "active" } : {}) })), ...history } };
}
