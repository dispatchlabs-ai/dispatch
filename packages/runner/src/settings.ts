import type { CompactionSettings, HarnessSettings } from "@earendil-works/pi-durable";
import { modelRetrySettings, type ModelRetry } from "./retry.js";

export type ServicePolicy = {
  retry?: ModelRetry;
  compaction?: CompactionSettings;
  afterFailedRun?: HarnessSettings["afterFailedRun"];
};

/** Installation policy only; Pi retains task, summary and inbox ownership. */
export function serviceSettings(policy: ServicePolicy): (() => HarnessSettings) | undefined {
  const retry = modelRetrySettings(policy.retry);
  const { compaction, afterFailedRun } = policy;
  if (afterFailedRun !== undefined && !["keep", "continue", "withdraw"].includes(afterFailedRun)) {
    throw new Error("afterFailedRun must be keep, continue or withdraw.");
  }
  const validate = (value: unknown, path: string, overrides: boolean) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be an object.`);
    for (const [key, item] of Object.entries(value)) {
      if (key === "enabled") {
        if (typeof item !== "boolean") throw new Error(`${path}.enabled must be boolean.`);
      } else if (["reserveTokens", "keepRecentTokens", "backgroundTokens"].includes(key)) {
        if (!Number.isSafeInteger(item) || (item as number) < (key === "backgroundTokens" ? 0 : 1)) {
          throw new Error(`${path}.${key} must be ${key === "backgroundTokens" ? "a nonnegative" : "a positive"} safe integer.`);
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
  if (!retry && compaction === undefined && afterFailedRun === undefined) return undefined;
  return () => ({ ...retry?.(), ...(compaction === undefined ? {} : { compaction }),
    ...(afterFailedRun === undefined ? {} : { afterFailedRun }) });
}
