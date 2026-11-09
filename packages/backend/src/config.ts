import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { HostModelsConfig } from "@dispatch/runner/host-models";
import type { ServicePolicy } from "@dispatch/runner/settings";
export interface Source { id: string; label: string; path: string; installation?: string }
export interface LocalConfig {
  definitionsRoot: string;
  host: HostModelsConfig & ServicePolicy & {
    cwd: string; namespace?: string; workspace?: { agents?: string[] }; artifacts?: unknown;
  };
  sources: Source[];
  defaultSource: string;
}
export interface Installation {
  id: string;
  label: string;
  definitionsRoot?: string;
  host?: LocalConfig["host"];
  /** Trusted consumer adapter; never a browser-supplied module or runtime lookup. */
  adapter?: { module: string; configFile: string };
}
export interface Config {
  definitionsRoot?: string;
  host?: LocalConfig["host"];
  sources: Source[];
  defaultSource: string;
  installations?: Installation[];
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
const absolute = (value: unknown): value is string => typeof value === "string" && isAbsolute(value);
export async function readConfig(): Promise<Config> {
  const path = process.env.DISPATCH_CONFIG;
  if (!absolute(path)) throw new Error("Set DISPATCH_CONFIG to an absolute consumer-owned JSON configuration file.");
  const value = JSON.parse(await readFile(path, "utf8")) as Config;
  if (!value || !Array.isArray(value.sources) || !value.sources.length || value.sources.some(source =>
    !source || !identifier(source.id) || typeof source.label !== "string" || !source.label.trim() || !absolute(source.path)) ||
    new Set(value.sources.map(source => source.id)).size !== value.sources.length ||
    !value.sources.some(source => source.id === value.defaultSource))
    throw new Error("Provide unique sources [{id,label,path}] with absolute paths and matching defaultSource.");
  if (value.installations === undefined) {
    if (!absolute(value.definitionsRoot) || !absolute(value.host?.cwd) || value.sources.some(source => source.installation !== undefined))
      throw new Error("Provide definitionsRoot and host.cwd, or named installations and explicit source bindings.");
  } else {
    if (!Array.isArray(value.installations) || !value.installations.length || value.installations.some(binding =>
      !binding || !identifier(binding.id) || typeof binding.label !== "string" || !binding.label.trim() ||
      (binding.adapter ? !absolute(binding.adapter.module) || !absolute(binding.adapter.configFile)
        : !absolute(binding.definitionsRoot) || !absolute(binding.host?.cwd))) ||
      new Set(value.installations.map(binding => binding.id)).size !== value.installations.length ||
      value.sources.some(source => !value.installations!.some(binding => binding.id === source.installation)))
      throw new Error("Each source must select one unique named installation with explicit absolute definitions/host or trusted adapter paths.");
  }
  return value;
}
export class AdmissionError extends Error { readonly status = 409; }
