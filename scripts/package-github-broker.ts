import { createHash } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { output: { type: "string" } }, strict: true });
if (!values.output) throw new Error("Usage: tsx scripts/package-github-broker.ts --output /path/broker.tar.gz");
const root = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (execFileSync("git", ["status", "--porcelain", "--", "packages/web/server", "packages/web/src/shared", "scripts/package-github-broker.ts", "package-lock.json"], { cwd: root, encoding: "utf8" }).trim())
  throw new Error("Commit the broker source and dependency lock before packaging.");
const staging = await mkdtemp(join(tmpdir(), "dispatch-broker-package-"));
try {
  await chmod(staging, 0o755);
  await mkdir(join(staging, "server", "github"), { recursive: true });
  await mkdir(join(staging, "server", "storage"), { recursive: true });
  for (const path of ["github/broker.js", "storage/restricted-config-file.js"])
    await cp(join(root, "packages/web/build/service/server", path), join(staging, "server", path));
  for (const name of ["hono", "@hono/node-server", "zod"])
    await cp(join(root, "node_modules", name), join(staging, "node_modules", name), { recursive: true, dereference: true });
  await cp(join(root, "LICENSE"), join(staging, "LICENSE"));
  const web = JSON.parse(await readFile(join(root, "packages/web/package.json"), "utf8"));
  await writeFile(join(staging, "package.json"), JSON.stringify({ name: "dispatch-github-broker", version: web.version, private: true, type: "module", engines: { node: ">=24.22.1 <25" } }, null, 2) + "\n");
  await writeFile(join(staging, "provenance.json"), JSON.stringify({ sourceRevision: revision, version: web.version, runtime: "Node.js >=24.22.1 <25", source: "https://github.com/dispatchlabs-ai/dispatch" }, null, 2) + "\n");
  const output = resolve(values.output);
  await mkdir(dirname(output), { recursive: true });
  execFileSync("tar", ["-czf", output, "-C", staging, "."]);
  const bytes = await readFile(output);
  console.log(JSON.stringify({ path: output, sourceRevision: revision, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length }));
} finally { await rm(staging, { recursive: true, force: true }); }
