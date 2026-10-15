import { createHash, createPrivateKey, sign, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { GitHubAccount, GitHubRepository } from "../../src/shared/github-access.js";
import { readRestrictedConfigurationFile } from "../storage/restricted-config-file.js";

const id = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const configSchema = z.object({
  host: z.literal("127.0.0.1").default("127.0.0.1"), port: z.number().int().min(1024).max(65535),
  apps: z.array(z.object({ id, keyFile: z.string().startsWith("/") }).strict()).min(1),
  clients: z.array(z.object({
    name: z.string().min(1), tokenFile: z.string().startsWith("/"),
    installations: z.array(z.object({ id: z.string().min(1).max(200), appId: id, installationId: id, accountId: id }).strict()).min(1),
  }).strict()).min(1),
}).strict();
type Installation = z.infer<typeof configSchema>["clients"][number]["installations"][number];
const hash = (value: string) => createHash("sha256").update(value).digest();
const compact = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const publicRepository = (repo: Record<string, any>): GitHubRepository => ({
  id: repo.id, name: repo.full_name, url: `https://github.com/${repo.full_name}.git`,
  private: repo.private, defaultBranch: repo.default_branch,
});

/** Central service: App keys stay here. Clients receive tokens restricted to one
 * repository and Contents read/write, never the installation's default scope. */
export async function openGitHubBroker(filename: string) {
  const config = configSchema.parse(JSON.parse(await readFile(filename, "utf8")));
  const keys = new Map(await Promise.all(config.apps.map(async app => [app.id,
    createPrivateKey(await readRestrictedConfigurationFile(app.keyFile, true))] as const)));
  const clients = await Promise.all(config.clients.map(async client => ({ ...client,
    tokenHash: hash((await readRestrictedConfigurationFile(client.tokenFile, true)).toString("utf8").trim()),
  })));
  const bots = new Map<string, GitHubAccount["bot"]>();
  for (const client of clients) {
    if (new Set(client.installations.map(installation => installation.id)).size !== client.installations.length
      || client.installations.some(installation => !keys.has(installation.appId))) throw new Error("Invalid GitHub broker installation configuration.");
  }
  function jwt(appId: number) {
    const now = Math.floor(Date.now() / 1000);
    const body = `${compact({ alg: "RS256", typ: "JWT" })}.${compact({ iat: now - 60, exp: now + 540, iss: String(appId) })}`;
    return `${body}.${sign("sha256", Buffer.from(body), keys.get(appId)!).toString("base64url")}`;
  }
  async function github(path: string, token: string, body?: unknown, method?: string): Promise<any> {
    const response = await fetch(`https://api.github.com${path}`, {
      method: method ?? (body === undefined ? "GET" : "POST"), redirect: "error", signal: AbortSignal.timeout(25_000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Dispatch-GitHub-broker" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error("GitHub request failed.");
    return response.status === 204 ? undefined : response.json();
  }
  async function account(binding: Installation): Promise<GitHubAccount> {
    const token = jwt(binding.appId);
    const [installation, app] = await Promise.all([
      github(`/app/installations/${binding.installationId}`, token), github("/app", token),
    ]);
    if (installation.app_id !== binding.appId || installation.account.id !== binding.accountId || installation.suspended_at
      || !["read", "write"].includes(installation.permissions.contents)) throw new Error("Installation is unavailable.");
    const botLogin = `${app.slug}[bot]`;
    let bot = bots.get(botLogin);
    if (!bot) {
      const user = await github(`/users/${encodeURIComponent(botLogin)}`, "");
      if (user.login !== botLogin || !Number.isSafeInteger(user.id)) throw new Error("App bot identity is unavailable.");
      bot = { login: user.login, id: user.id, email: `${user.id}+${user.login}@users.noreply.github.com` };
      bots.set(botLogin, bot);
    }
    return { id: binding.id, accountId: binding.accountId, login: installation.account.login,
      appId: binding.appId, appName: app.name, appUrl: app.html_url, installationId: binding.installationId,
      settingsUrl: installation.html_url, canWrite: installation.permissions.contents === "write",
      bot };
  }
  async function withInstallation<T>(binding: Installation, operation: (token: string) => Promise<T>) {
    const result = await github(`/app/installations/${binding.installationId}/access_tokens`, jwt(binding.appId), { permissions: { contents: "read", metadata: "read" } });
    try { return await operation(result.token); }
    finally { await github("/installation/token", result.token, undefined, "DELETE").catch(() => undefined); }
  }
  const app = new Hono();
  app.use("*", bodyLimit({ maxSize: 8192 }));
  app.use("*", async (c, next) => { c.header("Cache-Control", "no-store"); await next(); });
  app.onError(() => new Response(JSON.stringify({ error: "GitHub access is unavailable." }), {
    status: 502, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  }));
  app.get("/health", c => c.json({ ready: true }));
  app.post("/v1/:operation", async c => {
    const match = /^Bearer ([A-Za-z0-9_-]{43,200})$/.exec(c.req.header("Authorization") ?? "");
    const client = match && clients.find(candidate => timingSafeEqual(candidate.tokenHash, hash(match[1])));
    if (!client) return c.json({ error: "Forbidden" }, 403);
    const operation = c.req.param("operation");
    const input = await c.req.json();
    if (operation === "accounts") {
      z.object({}).strict().parse(input);
      return c.json({ accounts: await Promise.all(client.installations.map(account)) });
    }
    const request = z.object({ connectionId: z.string().min(1), page: z.number().int().min(1).optional(),
      repositoryId: id.optional(), permission: z.enum(["read", "write"]).optional() }).strict().parse(input);
    const binding = client.installations.find(installation => installation.id === request.connectionId);
    if (!binding) return c.json({ error: "Forbidden" }, 403);
    const identity = await account(binding);
    if (operation === "repositories") {
      const page = request.page ?? 1;
      const result = await withInstallation(binding, token => github(`/installation/repositories?per_page=100&page=${page}`, token));
      return c.json({ repositories: result.repositories.map(publicRepository), nextPage: page * 100 < result.total_count ? page + 1 : null });
    }
    if (!["repository", "credential"].includes(operation) || !request.repositoryId) return c.json({ error: "Invalid request" }, 400);
    // A repository-ID scoped token proves membership in this installation, even
    // when the repository is public or was renamed/transferred after selection.
    const permission = operation === "credential" ? request.permission ?? "read" : "read";
    if (permission === "write" && !identity.canWrite) return c.json({ error: "Write access is unavailable" }, 403);
    const issued = await github(`/app/installations/${binding.installationId}/access_tokens`, jwt(binding.appId), {
      repository_ids: [request.repositoryId], permissions: { contents: permission, metadata: "read" },
    });
    let released = false;
    try {
      const repos = await github("/installation/repositories?per_page=100", issued.token);
      const repo = repos.repositories.find((candidate: any) => candidate.id === request.repositoryId);
      if (!repo || repo.owner.id !== binding.accountId || repos.total_count !== 1) throw new Error("Repository is outside the installation.");
      if (operation === "repository") return c.json({ repository: publicRepository(repo), account: identity });
      released = true;
      return c.json({ token: issued.token, expiresAt: issued.expires_at, repository: publicRepository(repo), account: identity });
    } finally {
      if (!released) await github("/installation/token", issued.token, undefined, "DELETE").catch(() => undefined);
    }
  });
  return { app, host: config.host, port: config.port };
}

if (process.env.DISPATCH_GITHUB_BROKER_CONFIG_FILE) {
  const broker = await openGitHubBroker(process.env.DISPATCH_GITHUB_BROKER_CONFIG_FILE);
  serve({ fetch: broker.app.fetch, hostname: broker.host, port: broker.port });
}
