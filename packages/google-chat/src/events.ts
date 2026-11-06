export type GoogleChatConfig = {
  projectId: string;
  subscription: string;
  /** A Chat app can expose different definitions in different spaces. */
  spaces: Record<string, string>;
  allowedUsers?: string[];
};
export type GoogleChatInput = {
  transport: "google-chat"; project: string; space: string; thread: string; user: string;
  message: string; timestamp: string; key: string; text: string; agent: string;
};
export const googleThreadKey = (input: Pick<GoogleChatInput, "project" | "space" | "thread">) =>
  `google-chat:${input.project}:${input.space}:${input.thread}`;

/** Only call with messages from the app's publisher-restricted Pub/Sub topic. */
export function interaction(value: unknown, config: GoogleChatConfig): GoogleChatInput | null {
  if (!value || typeof value !== "object") throw new Error("Invalid Google Chat event.");
  const event = value as Record<string, any>;
  const payload = event.chat?.messagePayload ?? (event.type === "MESSAGE" || event.type === "ADDED_TO_SPACE" ? event : null);
  if (!payload?.message) return null;
  const message = payload.message;
  const space = payload.space?.name ?? message.space?.name;
  const thread = message.thread?.name;
  const user = message.sender ?? payload.user ?? event.chat?.user;
  const timestamp = message.createTime ?? event.eventTime;
  if (typeof space !== "string" || !/^spaces\/[A-Za-z0-9_-]+$/.test(space) || !config.spaces[space]) return null;
  if (user?.type !== "HUMAN" || !/^users\/\d+$/.test(user.name) ||
      config.allowedUsers && !config.allowedUsers.includes(user.name)) return null;
  if (typeof thread !== "string" || !thread.startsWith(`${space}/threads/`) ||
      !/^[A-Za-z0-9_-]+$/.test(thread.slice(`${space}/threads/`.length)) ||
      typeof message.name !== "string" || !message.name.startsWith(`${space}/messages/`) ||
      !Number.isFinite(Date.parse(timestamp))) throw new Error("Google Chat message identity is incomplete.");
  // argumentText removes this app's mention, leaving other people's mentions intact.
  let text = typeof message.argumentText === "string" ? message.argumentText : message.text;
  if (typeof text !== "string") text = "";
  const attachments = (Array.isArray(message.attachment) ? message.attachment : []).map((attachment: any) =>
    typeof attachment.contentName === "string" ? attachment.contentName : "attachment");
  if (attachments.length) text += `\n\nAttached files: ${attachments.join(", ")}. File bytes are not included in this message.`;
  if (!text.trim()) return null;
  return { transport: "google-chat", project: config.projectId, space, thread, user: user.name,
    message: message.name, timestamp: new Date(timestamp).toISOString(),
    key: `google-chat:${config.projectId}:${message.name}`, text: text.trim(), agent: config.spaces[space]! };
}
