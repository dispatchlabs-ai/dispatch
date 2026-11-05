import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { agentName, defaultAgent, loadAgent } from "./definition.js";

/** Remember the initial selection without changing any native conversation. */
export async function sessionAgent(root: string, directory: string, explicit?: string): Promise<string> {
  const path = join(directory, "conversation-agent.json");
  const retained = async () => {
    try {
      const value = JSON.parse(await readFile(path, "utf8"));
      if (value.version !== 1 || typeof value.agent !== "string" || !agentName.test(value.agent))
        throw new Error("Invalid retained conversation agent.");
      return value.agent as string;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
  const saved = await retained();
  if (saved) { await loadAgent(root, explicit ?? saved); return explicit ?? saved; }
  if (!explicit) {
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return [] as string[];
    });
    if (entries.length) throw new Error("This existing session has no saved default. Supply its original --agent once to retain that selection.");
  }
  const selected = explicit ?? await defaultAgent(root);
  await loadAgent(root, selected);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.conversation-agent-${randomUUID()}`);
  const file = await open(temporary, "wx", 0o600);
  try { await file.writeFile(JSON.stringify({ version: 1, agent: selected }) + "\n"); await file.sync(); }
  finally { await file.close(); }
  try { await link(temporary, path); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  finally { await rm(temporary, { force: true }); }
  const folder = await open(directory, "r");
  try { await folder.sync(); } finally { await folder.close(); }
  return explicit ?? (await retained())!;
}
