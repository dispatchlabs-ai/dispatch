import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (execFileSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" }).trim()) {
  throw new Error("Commit the source before building a deployment archive");
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
execFileSync("npm", ["run", "build", "--workspace", "@dispatch/inference-gateway"], { cwd: root, stdio: "inherit" });
const output = resolve(process.argv[2] ?? `${root}/.local/inference-gateway/${revision}.tar.gz`);
mkdirSync(dirname(output), { recursive: true });
execFileSync("tar", ["-czf", output, "LICENSE", "package.json", "package-lock.json", "packages/web/package.json", "packages/inference-gateway/package.json", "packages/inference-gateway/dist", "packages/inference-gateway/README.md"], { cwd: root, stdio: "inherit" });
console.log(JSON.stringify({ revision, archive: output }));
