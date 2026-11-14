import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

/** A package in the application's locked flake, runnable with `nix run`. */
export type AgentEnvironment = { package: string; description?: string };

export function validateEnvironment(environment: AgentEnvironment | undefined): void {
  if (environment === undefined) return;
  if (!environment || typeof environment.package !== "string"
    || !/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(environment.package)
    || (environment.description !== undefined && typeof environment.description !== "string")) {
    throw new Error("environment must select a repository flake package by name, with an optional description.");
  }
}

export function environmentInstructions(environment: AgentEnvironment | undefined, agent: string): string {
  if (!environment) return "";
  return `# Execution environment\nRepository Nix package: ${environment.package}.${environment.description ? ` ${environment.description}` : ""}\n`
    + `Inspect the selection with \`dispatch environment describe --agent ${agent}\`. `
    + "Explicit `build` and `run -- <arguments>` commands build or operate it. "
    + "Selecting an environment does not start it or redirect host tools into it. "
    + "Use its documented connection and execution interface for work inside it.";
}

/** Operates on source definitions; never opens an agent store or starts a host. */
export async function environmentCommand(
  operation: "describe" | "build" | "run", options: { root?: string; agent?: string }, args: string[] = [],
): Promise<void> {
  const root = await realpath(resolve(options.root ?? "."));
  const { defaultAgent, loadAgent } = await import("./definition.js");
  const agent = await loadAgent(root, options.agent ?? await defaultAgent(root));
  if (!agent.environment) throw new Error(`Agent ${agent.id} does not select an environment.`);
  if (operation !== "run" && args.length) throw new Error("Only environment run accepts arguments after --.");
  // Source checkouts retain Nix's Git filtering. Bundled definitions need an
  // explicit flake path: Nix otherwise treats /nix/store paths as built outputs.
  const installable = `${root.startsWith("/nix/store/") ? "path:" : ""}${root}#${agent.environment.package}`;
  if (operation === "describe") {
    console.log(JSON.stringify({ agent: agent.id, ...agent.environment, installable,
      build: ["nix", "build", "--no-update-lock-file", "--no-link", "--json", installable],
      run: ["nix", "run", "--no-update-lock-file", installable, "--"],
    }, null, 2));
    return;
  }
  await access(join(root, "flake.lock")).catch(() => { throw new Error("Commit a flake.lock before building or running an agent environment."); });
  const command = operation === "build"
    ? ["build", "--no-update-lock-file", "--no-link", "--json", installable]
    : ["run", "--no-update-lock-file", installable, "--", ...args];
  await new Promise<void>((done, reject) => {
    // Keep launcher-relative paths and avoid Nix's store-working-directory resolution.
    const child = spawn("nix", command, { stdio: "inherit", env: { ...process.env, DISPATCH_AGENT_ID: agent.id } });
    const interrupt = () => child.kill("SIGINT");
    const terminate = () => child.kill("SIGTERM");
    process.on("SIGINT", interrupt); process.on("SIGTERM", terminate);
    const cleanup = () => { process.off("SIGINT", interrupt); process.off("SIGTERM", terminate); };
    child.once("error", error => { cleanup(); reject(error); });
    child.once("close", (code, signal) => {
      cleanup();
      if (code === 0) done();
      else reject(new Error(`Environment ${operation} ${signal ? `ended with ${signal}` : `exited ${code}`}.`));
    });
  });
}
