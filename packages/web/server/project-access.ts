import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import type { ProjectRepository, ProjectSpec, RuntimeScope } from "../src/shared/contracts.js";

export type SharedProjectRecord = {
  id: string;
  companyId: string;
  name: string;
  cwd?: string;
  repositories?: ProjectRepository[];
  spec?: ProjectSpec;
  revision: number;
  createdAt: number;
  updatedAt: number;
  createdBy: string;
  members: { userId: string; role: "manager" | "member" }[];
  defaultAgentDefinitionIds: string[];
};

/** Current access policy is session state, never a rewindable conversation snapshot. */
export const ProjectsDoc = defineDoc<{
  projects: Record<string, SharedProjectRecord>;
  /** Actor-scoped request receipts; replay must still check the current project's permissions. */
  requests: Record<string, { fingerprint: string; projectId: string }>;
}>({
  kind: "dispatch.projects", version: 1, scope: "session",
  initial: () => ({ projects: {}, requests: {} }),
});

export type ProjectAccess = { read: boolean; participate: boolean; manage: boolean };
export type ProjectAction = keyof ProjectAccess;

/** The operator's read-all grant applies only within the authenticated company, never to mutations. */
export function projectAccess(project: Readonly<SharedProjectRecord> | undefined, scope: RuntimeScope, readAllProjects = false): ProjectAccess {
  const member = project?.companyId === scope.companyId ? project.members.find(member => member.userId === scope.userId) : undefined;
  return {
    read: project?.companyId === scope.companyId && (readAllProjects || member !== undefined),
    participate: member !== undefined,
    manage: member?.role === "manager",
  };
}

export class ProjectAccessError extends Error {
  readonly status = 404;
  constructor() { super("Project not found or access is not allowed."); }
}

/** Call on the same transaction that admits the protected mutation or reads its contents. */
export async function requireProjectAccess(tx: Tx, scope: RuntimeScope, id: string, action: ProjectAction, readAllProjects = false) {
  const policy = await tx.doc(ProjectsDoc);
  const project = policy.projects[id];
  if (!projectAccess(project, scope, readAllProjects)[action]) throw new ProjectAccessError();
  return project;
}
