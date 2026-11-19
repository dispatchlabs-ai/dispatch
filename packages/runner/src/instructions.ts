import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { getOrThrow } from "@earendil-works/pi-durable/env";
import { defineExtension, section } from "@earendil-works/pi-durable";
import { WorkspaceEnvironment } from "./workspace.js";

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

/** The heading that marks a file in an agent's definition instructions. */
const definitionHeading = (agentRoot: string, directory: string) => `# AGENTS.md from ${relative(agentRoot, directory) || "."}`;

export function formatRepositoryInstructions(sources: readonly RepositoryInstruction[], agentRoot: string): string {
  if (!sources.length) return "";
  return "These AGENTS.md files define this agent's shared rules. Source paths are relative to the agent definition repository, not the working directory. Apply their agent-behavior rules to every assignment. Repository-specific contributor commands and paths apply only to their source repository. More specific files refine the shared rules.\n\n"
    + sources.map(source => `${definitionHeading(agentRoot, dirname(source.path))}\n${source.text}`).join("\n\n");
}

/** Refresh target-repository guidance before each model request, including recovery.
 * A file is omitted only when the conversation's instructions verifiably hold this definition's
 * copies and the file's complete current text equals its copy. Anything else is shown in full. */
export function repositoryInstructionsExtension(definition: { root: string; sources: readonly RepositoryInstruction[] }) {
  // The formatted files open the definition's instructions, followed by its role heading.
  const prefix = definition.sources.length
    ? `${formatRepositoryInstructions(definition.sources, definition.root)}\n\n# Role instructions from ` : undefined;
  return defineExtension({
    name: "dispatch.repository-instructions",
    sections: [section("repository_instructions", async (input, context) => {
      if (!input.env?.cwd) return undefined;
      // Reading a chat's workspace here would start it on every request, including turns that never use it.
      if (input.env instanceof WorkspaceEnvironment && input.env.client.started === false) return undefined;
      const cwd = input.env.cwd;
      const env = input.env;
      const currentDirectory = getOrThrow(await env.canonicalPath(cwd, context));
      const directories: string[] = [];
      let current = currentDirectory;
      let repository = false;
      while (true) {
        directories.unshift(current);
        const git = getOrThrow(await env.joinPath([current, ".git"], context));
        if (getOrThrow(await env.exists(git, context))) { repository = true; break; }
        const parent = getOrThrow(await env.joinPath([current, ".."], context));
        if (parent === current) break;
        current = parent;
      }
      const instructions = input.agent.instructions ?? "";
      // An older saved definition or another agent's conversation has different copies: show every file.
      const copies = new Map(prefix !== undefined && instructions.startsWith(prefix)
        ? definition.sources.map(source => [source.path, source.text]) : []);
      const blocks: string[] = [];
      const included: string[] = [];
      for (const directory of repository ? directories : [currentDirectory]) {
        const path = getOrThrow(await env.joinPath([directory, "AGENTS.md"], context));
        if (!getOrThrow(await env.exists(path, context))) continue;
        const text = getOrThrow(await env.readTextFile(path, context)).trim();
        if (!text) continue;
        const copy = copies.get(path);
        const heading = `\n${definitionHeading(definition.root, directory)}\n`;
        if (copy === text) included.push(directory);
        else blocks.push(copy !== undefined || `\n${instructions}`.includes(heading)
          ? `# AGENTS.md from ${directory} (current version; it replaces this file's copy in your instructions)\n${text}`
          : `# AGENTS.md from ${directory}\n${text}`);
      }
      const note = included.length
        ? `Already part of your instructions: ${included.map(directory => `AGENTS.md from ${directory}`).join(", ")}.` : "";
      if (!blocks.length) return included.length ? `Working directory: ${cwd}. ${note}`
        : `Working directory: ${cwd}. No applicable AGENTS.md exists in this repository yet.`;
      return ["Target repository instructions apply within their named directories. More specific files govern their subtree.",
        ...blocks, ...(note ? [note] : [])].join("\n\n");
    })],
  });
}
