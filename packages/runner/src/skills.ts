import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { parse } from "yaml";

export type Skill = {
  id: string;
  description: string;
  revision: string;
  /** Startup snapshot: tools never read arbitrary paths or changed files. */
  files: ReadonlyMap<string, string>;
};

const skillName = /^[a-z][a-z0-9-]*$/;
const byName = (a: { name: string }, b: { name: string }) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

async function directory(path: string, optional = false): Promise<boolean> {
  const stat = await lstat(path).catch(error => {
    if (optional && error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!stat) return false;
  if (!stat.isDirectory()) throw new Error(`Skill directories must be ordinary directories: ${path}`);
  return true;
}

async function filesIn(folder: string, prefix = ""): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const entries = (await readdir(folder, { withFileTypes: true })).sort(byName);
  for (const entry of entries) {
    const key = `${prefix}${entry.name}`;
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      for (const [name, text] of await filesIn(path, `${key}/`)) files.set(name, text);
    } else if (entry.isFile()) {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(await readFile(path));
      if (text.includes("\0")) throw new Error(`Skill resources must be UTF-8 text: ${path}`);
      files.set(key, text);
    } else throw new Error(`Skill resources cannot be symlinks or special files: ${path}`);
  }
  return files;
}

/** Company skills plus this agent's own skills; no implicit shadowing. */
export async function loadSkills(root: string, agent: string): Promise<Skill[]> {
  if (!skillName.test(agent)) throw new Error(`Invalid agent name: ${agent}`);
  const skills: Skill[] = [];
  for (const [scope, folder] of [
    ["company", join(root, "skills")],
    ["agent", join(root, "agents", agent, "skills")],
  ]) {
    if (!await directory(folder, true)) continue;
    for (const entry of (await readdir(folder, { withFileTypes: true })).sort(byName)) {
      if (entry.isFile()) continue; // README files may explain a skill collection.
      if (!skillName.test(entry.name)) throw new Error(`Invalid skill directory: ${entry.name}`);
      const path = join(folder, entry.name);
      await directory(path);
      const files = await filesIn(path);
      const markdown = files.get("SKILL.md");
      const match = markdown && /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(markdown);
      const meta = match && parse(match[1]);
      if (!match || meta?.name !== entry.name || typeof meta.description !== "string" || !meta.description.trim() || !match[2].trim()) {
        throw new Error(`${path}/SKILL.md needs matching name, description and instructions.`);
      }
      skills.push({
        id: `${scope}/${entry.name}`, description: meta.description.trim(), files,
        revision: createHash("sha256").update(JSON.stringify([...files])).digest("hex"),
      });
    }
  }
  return skills;
}

export function skillInstructions(skills: Skill[]): string {
  if (!skills.length) return "";
  return `\n\nAvailable skills (guidance, not additional permissions):\n${skills.map(skill =>
    `- ${skill.id}: ${skill.description}`).join("\n")}\nWhen a skill applies, read its SKILL.md with read_skill before using it. Read listed supporting files with the same tool only when needed. Use the exact scoped skill ID; company and agent skills never override one another. Do not claim to run a script merely because you read it.`;
}

export function skillExtension(agent: string, skills: Skill[]) {
  return defineExtension({
    name: `dispatch.skills.${agent}`,
    tools: [defineTool({
      name: "read_skill",
      description: "Read a skill or one of its supporting text files. The initial response lists available paths and the exact content revision. Only this agent's company and personal skill catalog is accessible.",
      parameters: Type.Object({ id: Type.String(), path: Type.Optional(Type.String()) }),
      replay: "safe",
      execute: async ({ id, path = "SKILL.md" }) => {
        const skill = skills.find(candidate => candidate.id === id);
        if (!skill) throw new Error(`Unknown skill: ${id}`);
        const text = skill.files.get(path);
        if (text === undefined) throw new Error(`Unknown resource in ${id}: ${path}`);
        return { output: [{ type: "text", text: JSON.stringify({
          id, revision: skill.revision, path, files: [...skill.files.keys()], text,
        }) }] };
      },
    })],
  });
}
