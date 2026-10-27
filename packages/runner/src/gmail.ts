import type { Adapter } from "./run.js";

/** Compatibility entry point. Install @dispatch/email alongside Runner. */
export async function createAdapter(options: unknown): Promise<Adapter> {
  const module = "@dispatch/email";
  return (await import(module)).createAdapter(options);
}
