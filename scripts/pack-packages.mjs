#!/usr/bin/env node
// Prepare public npm artifacts only. This command never publishes or changes versions.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const [flag, output, ...extra] = process.argv.slice(2);
if (flag !== '--out' || !output || extra.length) throw new Error('Usage: npm run pack:packages -- --out NEW_DIRECTORY');
const destination = resolve(output);
const within = relative(root, destination);
const ancestor = relative(destination, root);
const inside = path => path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('../'));
if (inside(ancestor) || inside(within) && !within.startsWith('.local/')) {
  throw new Error('Use a new directory outside the checkout or inside .local/.');
}
const run = (command, args, cwd = root, capture = false) => execFileSync(command, args, { cwd, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit' });
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
const workspaces = new Map(manifest.workspaces.map(directory => {
  const pkg = JSON.parse(readFileSync(resolve(root, directory, 'package.json'), 'utf8'));
  return [pkg.name, { directory, ...pkg }];
}));
const ordered = [], visiting = new Set(), selected = new Set();
function visit(pkg) {
  if (selected.has(pkg.name)) return;
  if (visiting.has(pkg.name)) throw new Error(`Public dependency cycle: ${pkg.name}`);
  if (pkg.private === true || pkg.version !== manifest.version || !pkg.exports || !pkg.types || pkg.publishConfig?.access !== 'public') throw new Error(`Incomplete public package: ${pkg.name}`);
  visiting.add(pkg.name);
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) for (const [name, version] of Object.entries(pkg[field] ?? {})) {
    if (!workspaces.has(name)) continue;
    const dependency = workspaces.get(name);
    if (version !== dependency.version || dependency.private === true) throw new Error(`${pkg.name}: ${field} ${name} must be public and exactly versioned.`);
    visit(dependency);
  }
  visiting.delete(pkg.name); selected.add(pkg.name); ordered.push(pkg);
}
for (const pkg of workspaces.values()) if (pkg.private !== true) visit(pkg);
if (!ordered.length) throw new Error('No public packages selected.');
// Exclusive creation prevents mixing an old artifact set with current bytes.
mkdirSync(destination, { recursive: false, mode: 0o700 });
const artifacts = [];
for (const pkg of ordered) {
  run('npm', ['run', 'build', '--workspace', pkg.name]);
  const packed = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], resolve(root, pkg.directory), true))[0];
  const files = new Set(packed.files.map(file => file.path));
  for (const path of ['LICENSE', 'README.md', 'CHANGELOG.md', ...pkg.files.filter(path => /LICENSE|NOTICE/.test(path)), pkg.main, pkg.types, ...Object.values(pkg.exports).flatMap(entry => typeof entry === 'string' ? [entry] : [entry.import, entry.types]), ...Object.values(pkg.bin ?? {})]) {
    if (!path || !files.has(path.replace(/^\.\//, ''))) throw new Error(`${pkg.name}: missing shipped public file ${path}`);
  }
  const bytes = readFileSync(resolve(destination, packed.filename));
  artifacts.push({ name: pkg.name, version: pkg.version, tarball: packed.filename, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, sha256: createHash('sha256').update(bytes).digest('hex') });
}
const source = { commit: run('git', ['rev-parse', 'HEAD'], root, true).trim(), dirty: run('git', ['status', '--porcelain'], root, true).length > 0 };
writeFileSync(resolve(destination, 'manifest.json'), JSON.stringify({ format: 1, source, packages: artifacts }, null, 2) + '\n');
console.log(`Prepared ${artifacts.length} packages in dependency/publication order: ${destination}/manifest.json. Nothing published.`);
