import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { defineExtension, section } from "@earendil-works/pi-durable";

export type RepositoryInstruction = { path: string; revision: string; text: string };

/** Read only this repository's root-to-directory AGENTS.md chain. */
export async function loadRepositoryInstructions(directory: string, fallbackRoot = directory): Promise<RepositoryInstruction[]> {
  const cwd = await realpath(directory);
  const ancestors: string[] = [];
  let current = cwd;
  let foundRepository = false;
  while (true) {
    ancestors.unshift(current);
    const git = await stat(join(current, ".git")).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (git) { foundRepository = true; break; }
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  // A directory template may not have Git yet. Do not ingest unrelated host files.
  const fallback = await realpath(fallbackRoot);
  const boundary = ancestors.indexOf(fallback);
  if (!foundRepository && boundary < 0) throw new Error("The instruction root must contain the working directory.");
  const directories = foundRepository ? ancestors : ancestors.slice(boundary);
  const sources: RepositoryInstruction[] = [];
  for (const folder of directories) {
    const path = join(folder, "AGENTS.md");
    const text = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (text?.trim()) sources.push({ path, text: text.trim(), revision: createHash("sha256").update(text).digest("hex") });
  }
  return sources;
}

export function formatRepositoryInstructions(sources: readonly RepositoryInstruction[], scope: "agent" | "repository" = "repository"): string {
  if (!sources.length) return "";
  const heading = scope === "agent"
    ? "These AGENTS.md files define this agent's shared rules. Apply their agent-behavior rules to every assignment. Repository-specific contributor commands and paths apply only to their source repository. More specific files refine the shared rules."
    : "Target repository instructions apply within their named directories. More specific files govern their subtree.";
  return heading + "\n\n" + sources.map(source => `# AGENTS.md from ${dirname(source.path)}\n${source.text}`).join("\n\n");
}

/** Refresh target-repository guidance before each model request, including recovery. */
export function repositoryInstructionsExtension() {
  return defineExtension({
    name: "dispatch.repository-instructions",
    sections: [section("repository_instructions", async input => {
      if (!input.env?.cwd) return undefined;
      const cwd = input.env.cwd;
      return formatRepositoryInstructions(await loadRepositoryInstructions(cwd)) ||
        `Working directory: ${cwd}. No applicable AGENTS.md exists in this repository yet.`;
    })],
  });
}
