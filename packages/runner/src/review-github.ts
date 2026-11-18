import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { repositoryName } from "./review-source.js";

type Repo = { id: number; full_name: string; default_branch: string };
type Pull = { number: number; html_url: string; state: string; draft: boolean; title: string; head: { ref: string; repo: Repo | null }; base: { ref: string; repo: Repo } };
export type ReviewPull = { number: number; url: string; title: string; state: string; draft: boolean; branch: string };
export type ChangedFile = { path: string; mode: string; content: string };

/** The trusted publisher selects the repository, method and endpoint. No endpoint or ref comes from a model. */
export async function githubPublisher(repository: string, cwd: string, signal?: AbortSignal) {
  const root = "repos/" + repositoryName(repository);
  async function api<T>(route: string, body?: object): Promise<T> {
    const args = ["api", "--hostname", "github.com", "--method", body ? "POST" : "GET", root + route];
    if (body) args.push("--input", "-");
    return new Promise((accept, reject) => {
      const child = spawn("gh", args, { cwd, env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_DEBUG: "" }, signal, stdio: "pipe" });
      const output: Buffer[] = [], errors: Buffer[] = [];
      child.stdout.on("data", c => output.push(c)); child.stderr.on("data", c => errors.push(c));
      child.once("error", reject); child.stdin.on("error", () => {}); child.stdin.end(body ? JSON.stringify(body) : undefined);
      child.once("close", code => {
        const raw = Buffer.concat(output).toString();
        if (code !== 0) {
          let message = "GitHub request failed.";
          try { message = JSON.parse(raw).message ?? message; } catch { /* gh may return only an HTTP status. */ }
          const status = /HTTP (\d{3})/.exec(Buffer.concat(errors).toString())?.[1];
          reject(new Error(`GitHub ${body ? "POST" : "GET"} ${route.split("?")[0]}${status ? " (" + status + ")" : ""}: ${message}`));
        } else { try { accept(JSON.parse(raw) as T); } catch { reject(new Error("GitHub returned an unreadable receipt.")); } }
      });
    });
  }
  const target = await api<Repo>("");
  if (target.full_name.toLowerCase() !== repository) throw new Error("GitHub returned a different target repository.");
  const base = target.default_branch;
  const own = (item: Pull) => item.base.repo.id === target.id && item.head.repo?.id === target.id && item.base.ref === base;
  const receipt = (item: Pull): ReviewPull => {
    if (!own(item) || !/^dispatch-eval\/[a-f0-9]{32}$/.test(item.head.ref) || item.html_url !== `https://github.com/${target.full_name}/pull/${item.number}`)
      throw new Error("GitHub returned an unexpected proposal.");
    return { number: item.number, url: item.html_url, title: item.title, state: item.state, draft: item.draft, branch: item.head.ref };
  };
  async function find(branch: string) {
    const params = new URLSearchParams({ head: repository.split("/")[0] + ":" + branch, base, state: "all" });
    const match = (await api<Pull[]>("/pulls?" + params)).find(p => own(p) && p.head.ref === branch);
    return match && receipt(match);
  }
  async function current() {
    return (await api<{ sha: string; commit: { tree: { sha: string } } }>("/commits/" + encodeURIComponent(base)));
  }
  return { current, find,
    async recent() {
      const results: ReviewPull[] = [];
      for (let page = 1;; page++) {
        const list = await api<Pull[]>("/pulls?state=open&per_page=100&page=" + page);
        results.push(...list.filter(p => own(p) && /^dispatch-eval\/[a-f0-9]{32}$/.test(p.head.ref)).map(receipt));
        if (list.length < 100) return results;
      }
    },
    async publish(baseCommit: string, files: ChangedFile[], key: string, title: string, body: string) {
      const branch = "dispatch-eval/" + createHash("sha256").update(key).digest("hex").slice(0, 32);
      if (branch === base) throw new Error("The proposal branch cannot be the default branch.");
      const prior = await find(branch);
      if (prior) return prior;
      const parent = await current();
      if (parent.sha !== baseCommit) throw new Error("The default branch advanced. Prepare the proposal against its current contents.");
      const treeFor = (baseTree: string) => api<{ sha: string }>("/git/trees", { base_tree: baseTree,
        tree: files.map(({ path, mode, content }) => ({ path, mode, type: "blob", content })) });
      // Only create a new reference. On a retry, verify the existing branch still represents this exact edit.
      const refs = await api<{ ref: string; object: { sha: string } }[]>("/git/matching-refs/heads/" + branch);
      const ref = refs.find(r => r.ref === "refs/heads/" + branch);
      async function verifyHead() {
        const remote = await api<{ tree: { sha: string }; parents: { sha: string }[] }>("/git/commits/" + (await api<{ object: { sha: string } }>("/git/ref/heads/" + branch)).object.sha);
        if (remote.parents.length !== 1) throw new Error("A different commit already owns the proposal branch.");
        const original = await api<{ tree: { sha: string } }>("/git/commits/" + remote.parents[0].sha);
        if ((await treeFor(original.tree.sha)).sha !== remote.tree.sha) throw new Error("A different edit already owns the proposal branch.");
      }
      if (!ref) {
        const tree = await treeFor(parent.commit.tree.sha);
        const commit = await api<{ sha: string }>("/git/commits", { message: title, parents: [parent.sha], tree: tree.sha });
        try { await api("/git/refs", { ref: "refs/heads/" + branch, sha: commit.sha }); }
        catch (error) { await verifyHead().catch(() => { throw error; }); }
      } else await verifyHead();
      let created: Pull;
      try { created = await api<Pull>("/pulls", { title, body, head: branch, base, draft: true }); }
      catch (error) {
        const found = await find(branch);
        if (!found) throw error;
        return found;
      }
      if (!created.draft) throw new Error("GitHub did not confirm a draft pull request.");
      return receipt(created);
    },
  };
}
