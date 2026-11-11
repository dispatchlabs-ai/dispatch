import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** The Pi Durable this process actually loaded. */
export const piDurableVersion: string = (createRequire(import.meta.url)("@earendil-works/pi-durable/package.json") as { version: string }).version;

export type RuntimeSelection = { piDurable: string;
  /** Launcher that can restart an ordinary session on the selected runtime. */
  launch?: { node: string; module: string; root: string } };

export const runtimeSelectionFile = (runtimeRoot: string) => join(runtimeRoot, ".runtime.json");

const order = (a: string, b: string) => {
  const parse = (value: string) => value.split("-")[0].split(".").map(Number);
  const [x, y] = [parse(a), parse(b)];
  for (let index = 0; index < 3; index++) if ((x[index] ?? 0) !== (y[index] ?? 0)) return (x[index] ?? 0) - (y[index] ?? 0);
  return 0;
};

export async function readRuntimeSelection(runtimeRoot: string): Promise<RuntimeSelection | undefined> {
  try {
    const value = JSON.parse(await readFile(runtimeSelectionFile(runtimeRoot), "utf8")) as RuntimeSelection;
    if (typeof value?.piDurable !== "string" || !/^\d+\.\d+\.\d+/.test(value.piDurable)) throw new Error("Invalid runtime selection file.");
    return value;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
}

/** One Pi Durable per state root. The selection only moves forward: an older
 * runtime refuses to open stores here, and a newer one takes the root over;
 * owners on the previous version see the change and close (see agent-cli). */
export async function selectRuntime(runtimeRoot: string, launch?: RuntimeSelection["launch"]) {
  const selected = await readRuntimeSelection(runtimeRoot);
  const compared = selected ? order(piDurableVersion, selected.piDurable) : 1;
  if (compared < 0) throw new Error(`This state root runs Pi Durable ${selected!.piDurable}; this launcher carries ${piDurableVersion}. Use the installed current release. No store was opened.`);
  if (compared === 0 && (!launch || JSON.stringify(selected!.launch) === JSON.stringify(launch))) return;
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const temporary = join(runtimeRoot, `.runtime-${randomUUID()}`);
  await writeFile(temporary, JSON.stringify({ piDurable: piDurableVersion, launch: launch ?? (compared === 0 ? selected!.launch : undefined) }) + "\n", { mode: 0o600 });
  await rename(temporary, runtimeSelectionFile(runtimeRoot));
}
