import { execFileSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = (path: string) => JSON.parse(readFileSync(resolve(root, path), "utf8"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();

// SemVer precedence excludes build metadata; numeric prerelease identifiers cannot have leading zeros.
function parseVersion(version: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?$/.exec(version);
  if (!match || match[0] !== version) throw new Error(`Invalid SemVer: ${version}`);
  const core = match.slice(1, 4).map(Number);
  const pre = match[4]?.split(".") ?? [];
  if (core.some(n => !Number.isSafeInteger(n)) || pre.some(id => /^\d+$/.test(id) && id.length > 1 && id.startsWith("0"))) {
    throw new Error(`Invalid SemVer: ${version}`);
  }
  return { core, pre };
}

function compareVersions(left: string, right: string): number {
  const a = parseVersion(left), b = parseVersion(right);
  for (let i = 0; i < 3; i++) if (a.core[i] !== b.core[i]) return a.core[i] - b.core[i];
  if (!a.pre.length || !b.pre.length) return Number(!a.pre.length) - Number(!b.pre.length);
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i++) {
    const x = a.pre[i], y = b.pre[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xn = /^\d+$/.test(x), yn = /^\d+$/.test(y);
    if (xn && yn) return BigInt(x) > BigInt(y) ? 1 : -1;
    if (xn !== yn) return xn ? -1 : 1;
    return x > y ? 1 : -1;
  }
  return 0;
}

function main() {
  const [requested, ...flags] = process.argv.slice(2);
  if (!requested || flags.some(flag => flag !== "--dry-run") || flags.length > 1) {
    throw new Error("Usage: npm run release -- <patch|minor|major|version> [--dry-run]");
  }
  const dryRun = flags.includes("--dry-run");
  const manifest = readJson("package.json");
  const current = manifest.version as string;
  const { core, pre } = parseVersion(current);
  let next = requested;
  if (["patch", "minor", "major"].includes(requested)) {
    if (pre.length) throw new Error("Use an explicit version when releasing from a prerelease.");
    const index = { major: 0, minor: 1, patch: 2 }[requested as "major" | "minor" | "patch"];
    core[index]++;
    core.fill(0, index + 1);
    next = core.join(".");
  }
  if (compareVersions(next, current) <= 0) throw new Error(`Release must be newer than ${current}.`);
  if (!dryRun && git("status", "--porcelain")) throw new Error("Commit or stash changes before preparing a release.");
  if (git("tag", "--list", `v${next}`)) throw new Error(`Tag v${next} already exists.`);

  const workspacePatterns: string[] = manifest.workspaces;
  const packages = globSync(workspacePatterns.map(pattern => `${pattern}/package.json`), { cwd: root }).sort();
  if (!packages.length) throw new Error("No workspace packages found.");
  const workspaceNames = new Set(packages.map(path => readJson(path).name));
  const updates = new Map<string, string>();
  const lock = readJson("package-lock.json");
  if (lock.version !== current) throw new Error("Root lockfile version is not in lockstep.");
  for (const path of ["package.json", ...packages]) {
    const pkg = readJson(path);
    if (pkg.version !== current) throw new Error(`${path} is not in lockstep with ${current}.`);
    pkg.version = next;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      for (const [name, version] of Object.entries(pkg[field] ?? {})) {
        if (workspaceNames.has(name) && version === current) pkg[field][name] = next;
      }
    }
    const key = path === "package.json" ? "" : relative(root, resolve(root, dirname(path)));
    if (lock.packages[key]?.version !== current) throw new Error(`Lockfile version mismatch: ${path}`);
    lock.packages[key].version = next;
    for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
      if (pkg[field]) lock.packages[key][field] = pkg[field];
    }
    updates.set(path, `${JSON.stringify(pkg, null, 2)}\n`);
  }
  lock.version = next;
  updates.set("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);

  const contractPath = "packages/web/openapi.yaml";
  const contract = readJson(contractPath);
  if (contract.info.version !== current) throw new Error("Web API contract version is not in lockstep.");
  contract.info.version = next;
  updates.set(contractPath, `${JSON.stringify(contract, null, 2)}\n`);

  // Installation instructions name the immutable release archives. Rewrite only those
  // URLs and the current-release pointer; dated text such as "available since vX" stays.
  // Changelogs and the verification record are historical and keep their versions.
  const archive = /releases\/download\/v(\d+\.\d+\.\d+[^/]*)\/[a-z-]+-(\d+\.\d+\.\d+[^/]*?)\.tgz/g;
  const pointer = `The [v${current} release](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v${current})`;
  let pointers = 0;
  for (const path of git("ls-files", "*.md").split("\n").filter(Boolean)) {
    if (path.endsWith("CHANGELOG.md") || path === "docs/qualification.md") continue;
    const source = readFileSync(resolve(root, path), "utf8");
    const stale = [...source.matchAll(archive)].filter(match => match[1] !== current || match[2] !== current);
    if (stale.length) throw new Error(`${path} installs ${stale[0][0]}; update it to v${current} before preparing a release.`);
    pointers += source.split(pointer).length - 1;
    const updated = source.replace(archive, url => url.replaceAll(current, next))
      .replaceAll(pointer, `The [v${next} release](https://github.com/dispatchlabs-ai/dispatch/releases/tag/v${next})`);
    if (updated !== source) updates.set(path, updated);
  }
  if (!pointers) throw new Error(`scripts/README.md does not name the v${current} release.`);

  const date = new Date().toISOString().slice(0, 10);
  let changed = false;
  for (const path of packages) {
    const changelog = `${dirname(path)}/CHANGELOG.md`;
    const source = readFileSync(resolve(root, changelog), "utf8");
    const marker = "## [Unreleased]";
    if (!source.startsWith(`# Changelog\n\n${marker}\n`)) throw new Error(`${changelog} must start with ${marker}.`);
    const bodyStart = source.indexOf("\n", source.indexOf(marker)) + 1;
    const nextSection = source.indexOf("\n## ", bodyStart);
    const end = nextSection === -1 ? source.length : nextSection;
    const changes = source.slice(bodyStart, end).trim();
    if (!changes) continue;
    changed = true;
    updates.set(changelog, `# Changelog\n\n${marker}\n\n## [${next}] - ${date}\n\n${changes}\n${source.slice(end)}`);
  }
  if (!changed) throw new Error("No unreleased changelog entries to release.");
  console.log(`${dryRun ? "Preview" : "Prepare"} ${current} → ${next} (${date})`);
  for (const [path, content] of updates) {
    console.log(`  ${path}`);
    if (!dryRun) writeFileSync(resolve(root, path), content);
  }
  console.log(`Review and run repository checks before committing and creating tag v${next}. Nothing was published.`);
}

try { main(); } catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
