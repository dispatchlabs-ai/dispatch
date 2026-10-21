import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { GitHubAccount, GitHubRepository, GitHubPermission } from "../../src/shared/github-access.js";
import { readRestrictedConfigurationFile } from "../storage/restricted-config-file.js";

const configuration = z.object({
  url: z.url(), tokenFile: z.string().startsWith("/"), companyId: z.string().min(1),
  managerUserIds: z.array(z.string().min(1)).min(1),
}).strict();

/** Only the backend has the broker credential. The broker independently binds it
 * to allowed installations; a deployment cannot choose another installation ID. */
export class GitHubBrokerClient {
  private constructor(readonly companyId: string, readonly managerUserIds: readonly string[],
    private readonly url: string, private readonly token: string) {}

  static async open(filename: string | undefined) {
    if (!filename) return undefined;
    const config = configuration.parse(JSON.parse(await readFile(filename, "utf8")));
    const url = new URL(config.url);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/")
      throw new Error("GitHub broker must be an HTTPS origin.");
    const token = (await readRestrictedConfigurationFile(config.tokenFile, true)).toString("utf8").trim();
    if (!/^[A-Za-z0-9_-]{43,200}$/.test(token)) throw new Error("Invalid GitHub broker credential.");
    return new GitHubBrokerClient(config.companyId, config.managerUserIds, url.origin, token);
  }

  private async request<T>(operation: string, input: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.url}/v1/${operation}`, {
      method: "POST", redirect: "error", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify(input),
    });
    if (!response.ok) throw new Error("GitHub access is unavailable. Check the connection, repository and installation permissions.");
    return response.json() as Promise<T>;
  }

  accounts(signal?: AbortSignal) { return this.request<{ accounts: GitHubAccount[] }>("accounts", {}, signal); }
  repositories(connectionId: string, page: number, signal?: AbortSignal) {
    return this.request<{ repositories: GitHubRepository[]; nextPage: number | null }>("repositories", { connectionId, page }, signal);
  }
  repository(connectionId: string, repositoryId: number, signal?: AbortSignal) {
    return this.request<{ repository: GitHubRepository; account: GitHubAccount }>("repository", { connectionId, repositoryId }, signal);
  }
  credential(connectionId: string, repositoryId: number, permission: GitHubPermission, signal?: AbortSignal) {
    return this.request<{ token: string; expiresAt: string; repository: GitHubRepository; account: GitHubAccount }>(
      "credential", { connectionId, repositoryId, permission }, signal);
  }
}
