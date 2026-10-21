export type GitHubPermission = "read" | "write";

export type GitHubAccount = {
  id: string;
  accountId: number;
  login: string;
  appId: number;
  appName: string;
  appUrl: string;
  installationId: number;
  settingsUrl: string;
  canWrite: boolean;
  bot: { login: string; id: number; email: string };
};

export type GitHubRepository = {
  id: number;
  name: string;
  url: string;
  private: boolean;
  defaultBranch: string;
};

export type GitHubConnection = GitHubAccount & {
  companyId: string;
  connected: boolean;
  revision: number;
};

export type GitHubRepositoryBinding = GitHubRepository & {
  bindingId: string;
  companyId: string;
  projectId: string;
  connectionId: string;
  revision: number;
  grants: { definitionId: string; permission: GitHubPermission }[];
};

export type GitHubGrantedRepository = GitHubRepository & {
  bindingId: string;
  permission: GitHubPermission;
  bot: GitHubAccount["bot"];
};

export type GitHubCredential = GitHubGrantedRepository & { token: string; expiresAt: string };
export type GitHubOperation = "clone" | "fetch" | "push" | "inspect";
