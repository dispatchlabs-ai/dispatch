import type { BundleImportResult, BundlePreview, PortableAgent, PortableSkill } from "./bundles.js";

/** Server-verified public GitHub source; commit is a full immutable SHA. */
export type GitHubBundleSource = { owner: string; repository: string; commit: string; path: string };
export type GitHubInstallation = {
  id: string; revision: number; packageId: string; packageVersion: string;
  source: GitHubBundleSource; digest: string; updatedAt: number;
};
export type GitHubBundleChange = {
  kind: "agent" | "skill"; key: string; name: string;
  action: "add" | "update" | "unchanged" | "removed" | "conflict";
  before: PortableAgent | PortableSkill | null;
  local: PortableAgent | PortableSkill | null;
  incoming: PortableAgent | PortableSkill | null;
};
export type GitHubBundlePreview = BundlePreview & {
  previewId: string; source: GitHubBundleSource; digest: string;
  installationId: string | null; changes: GitHubBundleChange[];
};
export type GitHubBundleApplyInput = { previewId: string; requestId: string };
export type GitHubBundleApplyResult = BundleImportResult & { installation: GitHubInstallation };
