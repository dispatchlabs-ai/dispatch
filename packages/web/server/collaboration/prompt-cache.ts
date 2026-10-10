import type { Models, UserMessage } from "@earendil-works/pi-ai";

// Request-local identity distinguishes our suffix from participant-authored text.
const sharedUpdates = new WeakSet<object>();

export function sharedContextMessage(content: string): UserMessage {
  const message: UserMessage = { role: "user", content, timestamp: Date.now() };
  sharedUpdates.add(message);
  return message;
}

type Block = { type: string; text?: string; cache_control?: unknown };
type WireMessage = { role: string; content: string | Block[] };
type AnthropicPayload = { messages: WireMessage[] };
const cacheable = new Set(["text", "image", "tool_result", "tool_addition", "tool_removal"]);

/** Move Pi's history breakpoint before the transient suffix; preserve its TTL and opt-out. */
function cacheSavedHistory(payload: unknown, suffix: string): unknown {
  if (!payload || typeof payload !== "object" || !("messages" in payload) || !Array.isArray(payload.messages)) {
    throw new Error("Shared context cache boundary requires an Anthropic messages payload.");
  }
  const { messages } = payload as AnthropicPayload;
  const boundary = messages.findLastIndex(message => message.role === "user" && (
    message.content === suffix || (Array.isArray(message.content) && message.content.length === 1
      && message.content[0]?.type === "text" && message.content[0].text === suffix)
  ));
  if (boundary < 0) throw new Error("Shared context suffix is missing from the Anthropic request.");

  // Pi may flush pending system/tool updates after our user message. Their marker
  // also includes the transient suffix, so it must move with the history marker.
  let cacheControl: unknown;
  for (const message of messages.slice(boundary)) {
    if (!Array.isArray(message.content)) continue;
    for (const block of message.content) {
      if (block.cache_control !== undefined) {
        cacheControl = block.cache_control;
        delete block.cache_control;
      }
    }
  }
  if (cacheControl === undefined) return payload;
  for (let index = boundary - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (typeof message.content === "string") {
      if (!message.content.trim()) continue;
      message.content = [{ type: "text", text: message.content, cache_control: cacheControl }];
      return payload;
    }
    const block = message.content.findLast(item => cacheable.has(item.type));
    if (block) {
      block.cache_control = cacheControl;
      return payload;
    }
  }
  // A first request can contain only the suffix: Pi's system/tools markers still apply.
  return payload;
}

/** Use Pi's public request transform without replacing provider auth or native execution. */
export function withSharedContextCache(models: Models): Models {
  const streamSimple: Models["streamSimple"] = (model, context, options) => {
    const suffix = context.messages.at(-1);
    if (model.api !== "anthropic-messages" || !suffix || !sharedUpdates.has(suffix)
      || suffix.role !== "user" || typeof suffix.content !== "string") {
      return models.streamSimple(model, context, options);
    }
    const update = suffix.content;
    return models.streamSimple(model, context, {
      ...options,
      onPayload: async (payload, resolvedModel) => {
        const transformed = await options?.onPayload?.(payload, resolvedModel);
        return cacheSavedHistory(transformed ?? payload, update);
      },
    });
  };
  return new Proxy(models, {
    get(target, key) {
      if (key === "streamSimple") return streamSimple;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
