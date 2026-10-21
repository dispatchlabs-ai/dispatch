import type { AgentDraft } from "./contracts.js";

/** Resolved text data. Archive instruction paths are replaced with contents by the codec. */
export interface PortableBundle {
  formatVersion: 1;
  id: string;
  version: string;
  agents: PortableAgent[];
  skills: PortableSkill[];
}
export interface PortableSkill { key: string; name: string; description: string; instructions: string }
export interface PortableAgent extends Omit<AgentDraft, "skills" | "capabilities"> {
  key: string;
  skills: string[];
  capabilities: string[];
  omittedConnections: number;
}
export interface BundlePreview {
  bundle: PortableBundle;
  blockers: string[];
  warnings: string[];
}
export interface BundleImportResult {
  agents: { key: string; id: string }[];
  skills: { key: string; id: string }[];
}
export interface BundleExportInput {
  id: string;
  version: string;
  agentIds: string[];
  skills: { id: string; revision: number }[];
}
