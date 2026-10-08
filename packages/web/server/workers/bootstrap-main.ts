import { constants } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const directory = "/tmp/dispatch-bootstrap";
const manifestVariable = "DISPATCH_BOOTSTRAP_FILES";
const services = {
  backend: "./backend-main.js",
  launcher: "./control-main.js",
  auth: "../auth-cli.js",
  "provider-auth": "../provider-auth-cli.js",
} as const;
const manifestSchema = z.record(
  z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/),
  z.object({
    env: z.string().regex(/^[A-Z_][A-Z0-9_]*$/).refine(value => value !== manifestVariable),
    encoding: z.enum(["utf8", "base64"]).default("utf8"),
  }).strict(),
);

// This operator-only wrapper materializes ECS-injected values, not an application API.
// Never print parser/filesystem/exec errors: they can contain secret input or arguments.
let stage = "validation";
async function main() {
  const [service, ...args] = process.argv.slice(2);
  if (!service || !Object.hasOwn(services, service) || !process.execve)
    throw new Error("Unsupported service or execution platform.");
  const manifest = manifestSchema.parse(JSON.parse(process.env[manifestVariable] ?? ""));
  if (!Object.keys(manifest).length) throw new Error("Empty bootstrap manifest.");
  const environment = { ...process.env };
  const files: Array<{ name: string; bytes: Buffer }> = [];
  for (const [name, entry] of Object.entries(manifest)) {
    const value = process.env[entry.env];
    if (value === undefined || value.length === 0) throw new Error("Missing bootstrap value.");
    const bytes = Buffer.from(value, entry.encoding);
    // Buffer.from otherwise silently accepts malformed or truncated base64 input.
    if (entry.encoding === "base64" && bytes.toString("base64") !== value)
      throw new Error("Noncanonical bootstrap base64.");
    files.push({ name, bytes });
    delete environment[entry.env];
  }
  delete environment[manifestVariable];
  for (const entry of Object.values(manifest)) delete process.env[entry.env];
  delete process.env[manifestVariable];

  stage = "file materialization";
  process.umask(0o077);
  // Deliberately nonrecursive and exclusive: never follow/reuse a preexisting directory.
  // Partial failure leaves this private directory in place and blocks accidental retries.
  await mkdir(directory, { mode: 0o700 });
  for (const { name, bytes } of files) {
    const file = await open(join(directory, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await file.writeFile(bytes); }
    finally { bytes.fill(0); await file.close(); }
  }

  stage = "service execution";
  const entrypoint = fileURLToPath(new URL(services[service as keyof typeof services], import.meta.url));
  // Replace this process, retaining PID/signals/stdio without a shell or supervising child.
  // Node 24's execve discards the bootstrap heap and original inherited environment.
  process.execve(process.execPath, [process.execPath, entrypoint, ...args], environment);
}

main().catch(() => {
  console.error(`Dispatch bootstrap failed during ${stage}; service was not started. Inspect configuration privately.`);
  process.exitCode = 1;
});
