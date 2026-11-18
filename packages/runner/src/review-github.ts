import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { ReviewPending } from "./review-group.js";
import { repositoryName, type Proposal } from "./review-source.js";

type Repo = { id: number; full_name: string; default_branch: string };
type Pull = { number: number; html_url: string; state: string; draft: boolean; title: string; head: { ref: string; sha: string; repo: Repo | null }; base: { ref: string; repo: Repo } };
export type ReviewPull = { number: number; url: string; title: string; state: string; draft: boolean; branch: string };
export type OpenPull = ReviewPull & { head: string };
export type ChangedFile = { path: string; mode: string; content: string };

function branchName(key: string[][]) {
  return "dispatch-eval/" + createHash("sha256").update(JSON.stringify(key)).digest("hex").slice(0, 32);
}
export function proposalBranch(edits: Proposal["edits"]) {
  return branchName(edits.toSorted((a, b) => a.path.localeCompare(b.path)).map(({ path, before, after }) => [path, before, after]));
}

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
  const targetsBase = (item: Pull) => item.base.repo.id === target.id && item.base.ref === base;
  const own = (item: Pull) => targetsBase(item) && item.head.repo?.id === target.id && /^dispatch-eval\/[a-f0-9]{32}$/.test(item.head.ref);
  const receipt = (item: Pull): ReviewPull => {
    if (!targetsBase(item) || item.html_url !== `https://github.com/${target.full_name}/pull/${item.number}`)
      throw new Error("GitHub returned an unexpected pull request.");
    return { number: item.number, url: item.html_url, title: item.title, state: item.state, draft: item.draft, branch: item.head.ref };
  };
  async function find(branch: string) {
    if (!/^dispatch-eval\/[a-f0-9]{32}$/.test(branch)) return;
    const params = new URLSearchParams({ head: repository.split("/")[0] + ":" + branch, base, state: "all" });
    const match = (await api<Pull[]>("/pulls?" + params)).find(p => own(p) && p.head.ref === branch);
    return match && receipt(match);
  }
  async function current() {
    return (await api<{ sha: string; commit: { tree: { sha: string } } }>("/commits/" + encodeURIComponent(base)));
  }
  return { current, find,
    async recent() {
      const results: OpenPull[] = [];
      for (let page = 1;; page++) {
        const list = await api<Pull[]>("/pulls?state=open&base=" + encodeURIComponent(base) + "&per_page=100&page=" + page);
        results.push(...list.filter(targetsBase).map(p => ({ ...receipt(p), head: p.head.sha })));
        if (list.length < 100) return results.sort((a, b) => a.number - b.number);
      }
    },
    async publish(baseCommit: string, files: ChangedFile[], { edits, title }: Proposal, body: string) {
      const branch = proposalBranch(edits);
      if (branch === base) throw new Error("The proposal branch cannot be the default branch.");
      const prior = await find(branch);
      if (prior) return prior;
      // Older branches identified only the original passage. Reuse one only if
      // GitHub confirms every resulting file, including its proposed replacement.
      const legacy = await find(branchName(edits.map(({ path, before }) => [path, before]).sort()));
      if (legacy) {
        const expected = new Map(files.map(({ path, content }) => [path, createHash("sha1")
          .update("blob " + Buffer.byteLength(content) + "\0").update(content).digest("hex")]));
        let matched = true;
        for (let page = 1; ; page++) {
          const changed = await api<{ filename: string; sha: string }[]>(`/pulls/${legacy.number}/files?per_page=100&page=${page}`);
          for (const file of changed) {
            if (expected.get(file.filename) !== file.sha) matched = false;
            expected.delete(file.filename);
          }
          if (!matched || changed.length < 100) break;
        }
        if (matched && !expected.size) return legacy;
      }
      const parent = await current();
      if (parent.sha !== baseCommit) throw new ReviewPending("The default branch advanced. Refreshing the proposal comparison.");
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
      if (!created.draft || !own(created) || created.head.ref !== branch) throw new Error("GitHub did not confirm a draft pull request.");
      return receipt(created);
    },
  };
}
