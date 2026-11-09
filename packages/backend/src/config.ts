import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { HostModelsConfig } from "@dispatch/runner/host-models";
import type { ServicePolicy } from "@dispatch/runner/settings";
export interface Source {
  id: string;
  label: string;
  path: string;
}
export interface Config {
  definitionsRoot: string;
  host: HostModelsConfig &
    ServicePolicy & {
      cwd: string;
      namespace?: string;
      workspace?: { agents?: string[] };
      artifacts?: unknown;
    };
  sources: Source[];
  defaultSource: string;
}
export async function readConfig(): Promise<Config> {
  const path = process.env.DISPATCH_CONFIG;
  if (!path || !isAbsolute(path))
    throw new Error(
      "Set DISPATCH_CONFIG to an absolute consumer-owned JSON configuration file.",
    );
  const value = JSON.parse(await readFile(path, "utf8")) as Config;
  if (
    !isAbsolute(value.definitionsRoot ?? "") ||
    !isAbsolute(value.host?.cwd ?? "") ||
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    value.sources.some(
      (source) =>
        !/^[a-zA-Z0-9_-]+$/.test(source.id) ||
        !source.label?.trim() ||
        !isAbsolute(source.path),
    ) ||
    new Set(value.sources.map((source) => source.id)).size !==
      value.sources.length ||
    !value.sources.some((source) => source.id === value.defaultSource)
  )
    throw new Error(
      "Provide definitionsRoot, host.cwd, sources [{id,label,path}] and matching defaultSource. Paths must be absolute.",
    );
  return value;
}
export class AdmissionError extends Error {
  readonly status = 409;
}
