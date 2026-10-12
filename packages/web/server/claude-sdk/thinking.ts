import { getSupportedThinkingLevels, type Api, type AnthropicMessagesCompat, type Model, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { Options } from "@anthropic-ai/claude-agent-sdk";

export type ClaudeThinkingOptions = {
  thinking: NonNullable<Options["thinking"]>;
  effort?: Options["effort"];
};
/** Map the existing model catalog explicitly; SDK authentication does not require Pi provider credentials. */
export function claudeThinkingOptions(model: Model<Api>, level: ModelThinkingLevel): ClaudeThinkingOptions {
  if (model.provider !== "anthropic" || model.api !== "anthropic-messages") throw new Error("Agent SDK requires an Anthropic model.");
  if (!getSupportedThinkingLevels(model).includes(level)) throw new Error("The selected model does not support that thinking level.");
  if (level === "off") return { thinking: { type: "disabled" } };
  const compat = model.compat as AnthropicMessagesCompat | undefined;
  if (compat?.forceAdaptiveThinking || compat?.supportsMidConvoEffort) {
    const effort = model.thinkingLevelMap?.[level] ?? (level === "minimal" ? "low" : level);
    if (effort !== "low" && effort !== "medium" && effort !== "high" && effort !== "xhigh" && effort !== "max") {
      throw new Error("The model's thinking level cannot be represented by the Agent SDK.");
    }
    return { thinking: { type: "adaptive" }, effort };
  }
  // Pi 1.1.0's budget-based Anthropic defaults. Adaptive-only levels are not silently coerced.
  const budgets = { minimal: 1024, low: 2048, medium: 8192, high: 16384 };
  if (level === "xhigh" || level === "max") throw new Error("This model requires a budget-based thinking level.");
  return { thinking: { type: "enabled", budgetTokens: Math.min(budgets[level], Math.max(1024, model.maxTokens - 1024)) } };
}
