import { DEFAULT_COMPACTION_POLICY, type CompactionSettings, type HarnessSettings } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import { modelRetrySettings, type ModelRetry } from "./retry.js";

export type ServicePolicy = {
  retry?: ModelRetry;
  compaction?: CompactionSettings;
  afterFailedRun?: HarnessSettings["afterFailedRun"];
};

/** Installation policy only; Pi retains task, summary and inbox ownership. */
export function serviceSettings(policy: ServicePolicy, models?: Models): (() => HarnessSettings) | undefined {
  const retry = modelRetrySettings(policy.retry);
  let { compaction } = policy;
  const { afterFailedRun } = policy;
  if (afterFailedRun !== undefined && !["keep", "continue", "withdraw"].includes(afterFailedRun)) {
    throw new Error("afterFailedRun must be keep, continue or withdraw.");
  }
  const validate = (value: unknown, path: string, overrides: boolean) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
    for (const [key, item] of Object.entries(value)) {
      if (key === "enabled") {
        if (typeof item !== "boolean") throw new Error(`${path}.enabled must be boolean.`);
      } else if (["reserveTokens", "keepRecentTokens", "backgroundTokens"].includes(key)) {
        if (!Number.isSafeInteger(item) || (item as number) < (key === "reserveTokens" ? 1 : 0)) {
          throw new Error(`${path}.${key} must be ${key === "reserveTokens" ? "a positive" : "a nonnegative"} safe integer.`);
        }
      } else if (key === "modelOverrides" && overrides) {
        if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`${path}.modelOverrides must be an object.`);
        for (const [model, settings] of Object.entries(item)) {
          if (!model.includes("/") || model.startsWith("/") || model.endsWith("/")) throw new Error("Compaction model overrides require provider/modelId keys.");
          validate(settings, `${path}.modelOverrides[${model}]`, false);
        }
      } else throw new Error(`Unknown ${path} setting: ${key}`);
    }
  };
  if (compaction !== undefined) validate(compaction, "compaction", true);
  // Pi's defaults target large contexts. Fit its native budgets to smaller models;
  // explicit host budgets and conversation model overrides still take precedence.
  for (const model of models?.getModels() ?? []) {
    const window = model.contextWindow;
    if (window <= 0 || window > DEFAULT_COMPACTION_POLICY.reserveTokens + DEFAULT_COMPACTION_POLICY.keepRecentTokens) continue;
    const key = `${model.provider}/${model.id}`;
    const configured = compaction?.modelOverrides?.[key];
    const defaults: Partial<typeof DEFAULT_COMPACTION_POLICY> = {};
    for (const [field, divisor] of [["reserveTokens", 8], ["keepRecentTokens", 2], ["backgroundTokens", 4]] as const) {
      if (configured?.[field] === undefined && compaction?.[field] === undefined)
        defaults[field] = Math.min(DEFAULT_COMPACTION_POLICY[field], Math.max(1, Math.floor(window / divisor)));
    }
    if (Object.keys(defaults).length) compaction = { ...compaction, modelOverrides: {
      ...compaction?.modelOverrides, [key]: { ...defaults, ...configured },
    } };
  }
  if (!retry && compaction === undefined && afterFailedRun === undefined) return undefined;
  return () => ({ ...retry?.(), ...(compaction === undefined ? {} : { compaction }),
    ...(afterFailedRun === undefined ? {} : { afterFailedRun }) });
}
