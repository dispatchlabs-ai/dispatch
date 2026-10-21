import { createHash } from "node:crypto";
import { createReadStream, constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { acquireRuntimeOwner } from "./runtime-owner.js";

const roles = z.enum(["state", "workspace", "pi-agent", "connection-config", "operator-config"]);
const planSchema = z.object({
  storage: z.literal("sqlite"), codeRevision: z.string().min(1).max(200),
  roots: z.array(z.object({ role: roles, path: z.string().min(1) }).strict()).min(3).max(100),
}).strict();
const entrySchema = z.object({ path: z.string(), directory: z.boolean(), mode: z.number().int(), size: z.number().int().nonnegative(), sha256: z.string() }).strict();
const manifestSchema = z.object({ formatVersion: z.literal(1), plan: planSchema,
  roots: z.array(z.object({ role: roles, source: z.string(), entries: z.array(entrySchema) }).strict()),
}).strict();
type Entry = z.infer<typeof entrySchema>;
function fail(message: string): never { throw new Error(message); }
async function exists(path: string) {
  try { await lstat(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
// Check every existing path component, not just the final entry.
async function safeAbsolute(path: string): Promise<string> {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) fail("Symlink paths are unsupported.");
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  return realpath(absolute);
}
function overlaps(a: string, b: string) { return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep) || b.startsWith(a.endsWith(sep) ? a : a + sep); }
function separate(paths: string[]) {
  for (let i = 0; i < paths.length; i++) for (let j = i + 1; j < paths.length; j++)
    if (overlaps(paths[i], paths[j])) fail("Source and destination trees must not overlap.");
}
async function newDestination(path: string) {
  const absolute = resolve(path);
  if (await exists(absolute)) fail("Destination must not exist.");
  return join(await safeAbsolute(dirname(absolute)), basename(absolute));
}
async function digest(path: string) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
async function inventory(root: string): Promise<Entry[]> {
  const entries: Entry[] = [];
  async function visit(path: string) {
    const stat = await lstat(path);
    if (!stat.isDirectory() && !stat.isFile()) fail("Symlinks and special files are unsupported.");
    const directory = stat.isDirectory();
    entries.push({ path: relative(root, path).split(sep).join("/"), directory, mode: stat.mode & 0o777,
      size: directory ? 0 : stat.size, sha256: directory ? "" : await digest(path) });
    if (directory) for (const name of (await readdir(path)).sort()) await visit(join(path, name));
  }
  await visit(root);
  return entries;
}
function entryPath(root: string, path: string) {
  if (path && (isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".."))) fail("Unsafe recovery path.");
  return path ? join(root, ...path.split("/")) : root;
}
async function syncPath(path: string) {
  const handle = await open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function publishCompletion(destination: string, name: string, value: unknown) {
  // Publish the completion marker only after all payload entries are durable.
  await syncPath(destination);
  await syncPath(dirname(destination));
  const pending = join(destination, `${name}.pending`);
  await writeFile(pending, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await syncPath(pending);
  await rename(pending, join(destination, name));
  await syncPath(destination);
}
async function copyTree(source: string, destination: string, entries: Entry[]) {
  for (const entry of entries) {
    const from = entryPath(source, entry.path), to = entryPath(destination, entry.path);
    if (entry.directory) await mkdir(to, { mode: 0o700 });
    else {
      await copyFile(from, to, constants.COPYFILE_EXCL);
      await chmod(to, 0o600 | (entry.mode & 0o100));
      if (await digest(to) !== entry.sha256 || (await lstat(to)).size !== entry.size) fail("Recovery copy checksum mismatch.");
      await syncPath(to);
    }
  }
  for (const entry of [...entries].reverse()) if (entry.directory) await syncPath(entryPath(destination, entry.path));
  await syncPath(dirname(destination));
}
async function assertSqlite(state: string) {
  if (await exists(join(state, "runtime/postgres-store.json"))) fail("PostgreSQL recovery is unsupported.");
  for (const file of ["runtime/pi.sqlite", "auth.sqlite", "auth.key", "connections.sqlite", "connections.key"])
    if (!(await lstat(join(state, file))).isFile()) fail("Required SQLite recovery material is missing.");
}

const help = `Offline SQLite recovery (secret-bearing trusted material only)

node build/service/server/recovery-cli.js backup --plan PLAN.json --destination NEW_DIRECTORY --writers-stopped
node build/service/server/recovery-cli.js restore --backup DIRECTORY --destination NEW_DIRECTORY --writers-stopped --original-fenced --paths-reviewed --code-revision REVISION

Plan: {"storage":"sqlite","codeRevision":"<deployed immutable revision>","roots":[{"role":"state","path":"..."},{"role":"workspace","path":"..."},{"role":"pi-agent","path":"..."}]}
Additional roles: connection-config, operator-config. Roots must exist and be disjoint.
Include every external workspace/configuration/credential dependency explicitly.
Stop supervisors, service, auth CLI, provider refreshers and all other writers first.
The runtime lock is an extra guard, NOT proof of whole-installation shutdown.
Restore creates numbered root directories; reconcile stored absolute working-directory,
credential paths, origin/company and external environment secrets before manually starting.
Never run original and restored owners together. Checksums do not authenticate a backup.
A failure leaves an incomplete restricted destination for operator inspection; never start it.
`;

try {
  process.umask(0o077);
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    plan: { type: "string" }, backup: { type: "string" }, destination: { type: "string" },
    "code-revision": { type: "string" }, "writers-stopped": { type: "boolean" },
    "original-fenced": { type: "boolean" }, "paths-reviewed": { type: "boolean" }, help: { type: "boolean" },
  } });
  if (values.help) console.log(help);
  else {
    if (!values["writers-stopped"] || !values.destination) fail(help);
    const destination = await newDestination(values.destination);
    if (positionals.length !== 1) fail(help);
    if (positionals[0] === "backup") {
      if (!values.plan) fail(help);
      const plan = planSchema.parse(JSON.parse(await readFile(values.plan, "utf8")));
      for (const role of ["state", "workspace", "pi-agent"] as const)
        if (plan.roots.filter(root => root.role === role).length !== 1) fail(`Exactly one ${role} root is required.`);
      const sources = await Promise.all(plan.roots.map(root => safeAbsolute(root.path)));
      separate([...sources, destination]);
      const state = sources[plan.roots.findIndex(root => root.role === "state")];
      await safeAbsolute(join(state, "runtime"));
      await inventory(state);
      await assertSqlite(state);
      const owner = await acquireRuntimeOwner(join(state, "runtime"));
      try {
        await mkdir(destination, { mode: 0o700 });
        const roots = [];
        for (let i = 0; i < sources.length; i++) {
          const entries = await inventory(sources[i]);
          // The ownership transaction is ephemeral, not recoverable application state.
          const retained = plan.roots[i].role === "state" ? entries.filter(entry => !/^runtime\/runtime-owner\.sqlite(?:-.*)?$/.test(entry.path)) : entries;
          await copyTree(sources[i], join(destination, String(i)), retained);
          roots.push({ role: plan.roots[i].role, source: sources[i], entries: retained });
        }
        await publishCompletion(destination, "manifest.json", { formatVersion: 1, plan, roots });
      } finally { owner.release(); }
      console.log("Backup written. Protect it as secret-bearing recovery material.");
    } else if (positionals[0] === "restore") {
      if (!values.backup || !values["original-fenced"] || !values["paths-reviewed"] || !values["code-revision"]) fail(help);
      const backup = await safeAbsolute(values.backup);
      separate([backup, destination]);
      await inventory(backup); // Reject unlisted symlinks/special files too.
      const manifest = manifestSchema.parse(JSON.parse(await readFile(join(backup, "manifest.json"), "utf8")));
      if (manifest.plan.codeRevision !== values["code-revision"]) fail("Code revision differs from the recovery set.");
      for (const role of ["state", "workspace", "pi-agent"] as const)
        if (manifest.roots.filter(root => root.role === role).length !== 1) fail(`Exactly one ${role} root is required.`);
      separate([...manifest.roots.map(root => resolve(root.source)), destination]);
      if (manifest.roots.length !== manifest.plan.roots.length) fail("Recovery root count mismatch.");
      for (let i = 0; i < manifest.roots.length; i++) {
        const root = manifest.roots[i];
        if (root.role !== manifest.plan.roots[i].role) fail("Recovery role mismatch.");
        if (JSON.stringify(await inventory(join(backup, String(i)))) !== JSON.stringify(root.entries.map(entry => ({ ...entry, mode: entry.directory ? 0o700 : 0o600 | (entry.mode & 0o100) })))) fail("Recovery inventory mismatch.");
        if (root.role === "state") await assertSqlite(join(backup, String(i)));
      }
      await mkdir(destination, { mode: 0o700 });
      for (let i = 0; i < manifest.roots.length; i++) await copyTree(join(backup, String(i)), join(destination, String(i)), manifest.roots[i].entries);
      await publishCompletion(destination, "RECOVERY.json", manifest);
      console.log("Restore copied; NOT started. Reconcile paths/configuration before manual recovery.");
    } else fail(help);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Recovery failed.");
  process.exitCode = 1;
}
