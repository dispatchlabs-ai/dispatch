import type { HarnessSettings } from "@earendil-works/pi-durable";

/** Installation policy; Pi owns classification, checkpoints, sleeps and recovery. */
export type ModelRetry = {
  enabled?: boolean;
  /** "persistent" uses the largest exact native retry count (not a new task loop). */
  maxRetries?: number | "persistent";
  baseDelayMs?: number;
  maxAgentDelayMs?: number;
  /** Fractional downward jitter, sampled when Pi reads settings; zero disables it. */
  jitter?: number;
};

export function modelRetrySettings(policy: ModelRetry | undefined): (() => HarnessSettings) | undefined {
  if (policy === undefined) return undefined;
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) throw new Error("retry must be an object.");
  for (const key of Object.keys(policy)) {
    if (!["enabled", "maxRetries", "baseDelayMs", "maxAgentDelayMs", "jitter"].includes(key)) throw new Error(`Unknown retry setting: ${key}`);
  }
  const { enabled = true, maxRetries = 3, baseDelayMs = 2000, maxAgentDelayMs = 60000, jitter = 0 } = policy;
  if (typeof enabled !== "boolean") throw new Error("retry.enabled must be boolean.");
  if (maxRetries !== "persistent" && (!Number.isSafeInteger(maxRetries) || maxRetries < 0)) throw new Error("retry.maxRetries must be a nonnegative safe integer or persistent.");
  for (const [name, value] of Object.entries({ baseDelayMs, maxAgentDelayMs })) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`retry.${name} must be a positive safe integer.`);
  }
  if (baseDelayMs > maxAgentDelayMs) throw new Error("retry.baseDelayMs must not exceed maxAgentDelayMs.");
  if (typeof jitter !== "number" || !Number.isFinite(jitter) || jitter < 0 || jitter >= 1) throw new Error("retry.jitter must be in [0, 1).");
  return () => {
    // Pi commits the resulting deadline before sleeping, so recovery keeps it.
    const factor = 1 - jitter * Math.random();
    return { retry: {
      enabled, maxRetries: maxRetries === "persistent" ? Number.MAX_SAFE_INTEGER : maxRetries,
      baseDelayMs: Math.max(1, Math.floor(baseDelayMs * factor)),
      maxAgentDelayMs: Math.max(1, Math.floor(maxAgentDelayMs * factor)),
    } };
  };
}
