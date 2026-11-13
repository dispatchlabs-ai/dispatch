import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ServiceConnection } from "./service-runtime.js";

export interface Source { id: string; label: string; path: string; installation?: string; exclude?: string[] }
export interface Installation {
  id: string;
  label: string;
  service: ServiceConnection & { stateRoot?: string };
}
export interface Config {
  service?: ServiceConnection;
  installations?: Installation[];
  /** Optional read-only retained stores. They never become execution owners. */
  sources?: Source[];
}
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9_-]+$/.test(value);
export async function readConfig(): Promise<Config> {
  const path = process.env.DISPATCH_CONFIG;
  if (!path || !isAbsolute(path)) throw new Error("Set DISPATCH_CONFIG to an absolute application configuration file.");
  const value = JSON.parse(await readFile(path, "utf8")) as Config;
  if (value.service) return value;
  if (!value.installations?.length || value.installations.some(binding => !identifier(binding.id) || !binding.label?.trim() || !binding.service) ||
    new Set(value.installations.map(binding => binding.id)).size !== value.installations.length)
    throw new Error("Configure service, or named installations with a service connection each. Backend connects to existing hosts.");
  for (const source of value.sources ?? []) {
    if (!identifier(source.id) || !source.label?.trim() || !isAbsolute(source.path) ||
      !value.installations.some(binding => binding.id === source.installation) || source.exclude?.some(path => !isAbsolute(path)))
      throw new Error("Each read-only source needs an absolute path and its installation ID.");
  }
  return value;
}
export class AdmissionError extends Error { readonly status = 409; }
