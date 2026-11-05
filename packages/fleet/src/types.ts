import type { Storage } from "@earendil-works/pi-durable";
import type { createModels } from "@earendil-works/pi-ai/models";
import type { WorkspaceEnvironment, WorkspaceTransport } from "@dispatch/runner";
import type { GatewayAliases, ModelChoice } from "@dispatch/runner/gateway";

/** Selected by the trusted coordinator from a verified application archive. */
export type FleetRelease = { manifest: string; archiveKey: string; archiveSha256: string };
export type FleetAssignment = {
  run: string;
  release: FleetRelease;
  input: unknown;
  /** The native adapter must cancel retained tasks before enabling recovery. */
  cancelPending?: boolean;
  fleet?: { workerId: string; epoch: number };
};
export type FleetRun = {
  /** `tool: 'cancel'` must durably cancel native work before acknowledging. */
  command(value: unknown, signal: AbortSignal): Promise<unknown>;
  status(): Promise<unknown>;
  /** Suspend retained work. Cancellation is an explicit application command. */
  close(): Promise<void>;
};
export type FleetRunContext = {
  assignment: FleetAssignment;
  root: string;
  namespace: string;
  roles: readonly string[];
  stateRoot: string;
  runtimeRoot: string;
  storage(agent: { id: string } | string): Promise<Storage>;
  workspace: WorkspaceTransport;
  env(target: { cwd?: string }): WorkspaceEnvironment;
  relay<T = unknown>(path: string, body?: unknown, options?: { method?: "GET" | "POST"; signal?: AbortSignal }): Promise<T>;
  /** The coordinator acknowledges only after retaining the transport receipt. */
  emit(event: unknown): Promise<void>;
  connectModels(aliases?: GatewayAliases): Promise<{ models: ReturnType<typeof createModels>; choices: ModelChoice[] }>;
};
export type FleetRunModule = { createRun(context: FleetRunContext): Promise<FleetRun> };

export type FleetRunStatus = {
  assignment: FleetAssignment & { suspended?: boolean; finished?: boolean; fleetPending?: boolean };
  native?: unknown;
};
