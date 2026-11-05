import type { WebClient } from "@slack/web-api";

/** The Web API surface used by native Slack admission and delivery tasks. */
export type SlackWebApi = {
  auth: Pick<WebClient["auth"], "test">;
  assistant: { threads: Pick<WebClient["assistant"]["threads"], "setStatus"> };
  chat: Pick<WebClient["chat"], "appendStream" | "delete" | "postMessage" | "startStream" | "stopStream" | "update">;
  conversations: Pick<WebClient["conversations"], "replies">;
  files: Pick<WebClient["files"], "completeUploadExternal" | "getUploadURLExternal" | "info">;
};
type Methods = {
  "auth.test": SlackWebApi["auth"]["test"];
  "assistant.threads.setStatus": SlackWebApi["assistant"]["threads"]["setStatus"];
  "chat.appendStream": SlackWebApi["chat"]["appendStream"];
  "chat.delete": SlackWebApi["chat"]["delete"];
  "chat.postMessage": SlackWebApi["chat"]["postMessage"];
  "chat.startStream": SlackWebApi["chat"]["startStream"];
  "chat.stopStream": SlackWebApi["chat"]["stopStream"];
  "chat.update": SlackWebApi["chat"]["update"];
  "conversations.replies": SlackWebApi["conversations"]["replies"];
  "files.completeUploadExternal": SlackWebApi["files"]["completeUploadExternal"];
  "files.getUploadURLExternal": SlackWebApi["files"]["getUploadURLExternal"];
  "files.info": SlackWebApi["files"]["info"];
};
export type SlackApiMethod = keyof Methods;
export type SlackApiCall = (method: SlackApiMethod, arguments_: Record<string, unknown>) => Promise<unknown>;

/** A trusted, token-free relay. The host must enforce method and thread scope. */
export function createSlackWebApi(call: SlackApiCall): SlackWebApi {
  const method = <Name extends SlackApiMethod>(name: Name): Methods[Name] =>
    (async (arguments_: Record<string, unknown> = {}) => {
      const result = await call(name, arguments_);
      const failure = result as { ok?: boolean; error?: string; retryAfter?: number } | undefined;
      if (failure?.ok === false) {
        throw Object.assign(new Error(`Slack API ${name} failed: ${failure.error ?? "request_failed"}.`), {
          data: { error: failure.error }, retryAfter: failure.retryAfter,
        });
      }
      return result;
    }) as Methods[Name];
  return {
    auth: { test: method("auth.test") },
    assistant: { threads: { setStatus: method("assistant.threads.setStatus") } },
    chat: {
      appendStream: method("chat.appendStream"), delete: method("chat.delete"),
      postMessage: method("chat.postMessage"), startStream: method("chat.startStream"),
      stopStream: method("chat.stopStream"), update: method("chat.update"),
    },
    conversations: { replies: method("conversations.replies") },
    files: {
      completeUploadExternal: method("files.completeUploadExternal"),
      getUploadURLExternal: method("files.getUploadURLExternal"), info: method("files.info"),
    },
  };
}
