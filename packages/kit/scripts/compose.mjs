#!/usr/bin/env node
// Composes one definitions root: the kit first, the company tree on top.
//   node scripts/compose.mjs KIT COMPANY DESTINATION [SUMMARY.json]
// A company file at a kit path needs a reason in the company's kit.json.
// agents/ROLE/company.md is appended to the kit's agents/ROLE/agent.md, and
// DIR/NAME.company.md to any other kit DIR/NAME.md. kit.json can also omit
// kit files or directories it does not want, each with a reason.
// Every problem is reported before the build fails.
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const [kit, company, destination, summaryPath] = process.argv.slice(2);
if (!kit || !company || !destination) throw new Error('Usage: compose.mjs KIT COMPANY DESTINATION [SUMMARY.json]');

const declaration = 'kit.json';
const addendum = 'company.md';
const kitDirectories = ['agents', 'skills', 'kit'];

function list(root, directories) {
  const files = [];
  const walk = prefix => {
    for (const entry of readdirSync(join(root, prefix), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path); else files.push(path);
    }
  };
  if (directories) for (const directory of directories) { if (existsSync(join(root, directory))) walk(directory); }
  else walk('');
  return files;
}

function place(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  const stat = lstatSync(source);
  if (stat.isSymbolicLink()) symlinkSync(readlinkSync(source), target);
  else {
    copyFileSync(source, target);
    chmodSync(target, stat.mode & 0o111 ? 0o755 : 0o644);
  }
}

const problems = [];
const kitFiles = list(kit, kitDirectories);
const kitPaths = new Set(kitFiles);
const kitFolders = new Set(kitFiles.flatMap(path => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))));
const companyFiles = list(company);
const companyPaths = new Set(companyFiles);

let replacements = {};
let omissions = {};
if (companyPaths.has(declaration)) {
  let declared;
  try { declared = JSON.parse(readFileSync(join(company, declaration), 'utf8')); }
  catch (error) { problems.push(`${declaration} is not valid JSON: ${error.message}`); }
  if (declared !== undefined) {
    const plain = value => value && typeof value === 'object' && !Array.isArray(value);
    if (!plain(declared) || Object.keys(declared).some(key => key !== 'replacements' && key !== 'omit')
      || (declared.replacements !== undefined && !plain(declared.replacements)) || (declared.omit !== undefined && !plain(declared.omit))) {
      problems.push(`${declaration} must be {"replacements": {"PATH": "REASON"}, "omit": {"PATH": "REASON"}} and nothing else.`);
    } else { replacements = declared.replacements ?? {}; omissions = declared.omit ?? {}; }
  }
}
for (const [path, reason] of Object.entries(replacements)) {
  if (typeof reason !== 'string' || !reason.trim()) problems.push(`${declaration}: the replacement of ${path} needs a reason.`);
  if (!kitPaths.has(path)) problems.push(`${declaration} declares a replacement of ${path}, but the kit has no such file. Remove the entry.`);
  else if (!companyPaths.has(path)) problems.push(`${declaration} declares a replacement of ${path}, but the company tree has no such file. Remove the entry or add the file.`);
}

const omitted = path => Object.keys(omissions).some(entry => path === entry || path.startsWith(`${entry}/`));
for (const [path, reason] of Object.entries(omissions)) {
  if (typeof reason !== 'string' || !reason.trim()) problems.push(`${declaration}: omitting ${path} needs a reason.`);
  if (!kitPaths.has(path) && !kitFolders.has(path)) problems.push(`${declaration} omits ${path}, but the kit has no such file or directory. Remove the entry.`);
  else if (path === 'kit' || path.startsWith('kit/')) problems.push(`${declaration} omits ${path}, which kit agents import or link. Omit agents or skills instead.`);
  for (const replaced of Object.keys(replacements)) if (omitted(replaced)) problems.push(`${declaration} both omits and replaces ${replaced}. Keep one of the two.`);
}

// agents/ROLE/company.md extends agents/ROLE/agent.md; DIR/NAME.company.md extends DIR/NAME.md.
const addendumTarget = path => {
  const parts = path.split('/');
  if (parts.length === 3 && parts[0] === 'agents' && parts[2] === addendum) return `agents/${parts[1]}/agent.md`;
  return path.endsWith('.company.md') ? `${path.slice(0, -'.company.md'.length)}.md` : null;
};
const addenda = [];
for (const path of companyFiles) {
  if (kitPaths.has(path)) {
    if (!(path in replacements)) problems.push(`${path} is a kit file. To replace it, declare it with a reason in ${declaration}: {"replacements": {"${path}": "why this company needs its own"}}. To add to a kit role without replacing it, use agents/ROLE/${addendum}.`);
    continue;
  }
  if (kitFolders.has(path)) problems.push(`${path} is a directory in the kit and a file in the company tree.`);
  const parts = path.split('/');
  if (parts.slice(1).some((_, index) => kitPaths.has(parts.slice(0, index + 1).join('/')))) problems.push(`${path} lies under a path that is a file in the kit.`);
  const target = addendumTarget(path);
  if (target === null) continue;
  const named = parts[parts.length - 1] === addendum;
  if (!kitPaths.has(target)) { if (named) problems.push(`${path} is an addendum to a kit role, but the kit has no ${target}. Put a company agent's instructions in its own agent.md.`); }
  else if (omitted(target)) problems.push(`${path} is an addendum to ${target}, which ${declaration} omits. Keep one of the two.`);
  else if (target in replacements) problems.push(`${path} is an addendum to ${target}, which ${declaration} replaces. Keep one of the two.`);
  else if (!readFileSync(join(company, path), 'utf8').trim()) problems.push(`${path} is empty.`);
  else addenda.push([path, target]);
}

if (problems.length) {
  console.error(`The kit and the company tree do not compose:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
  process.exit(1);
}

for (const path of kitFiles) if (!companyPaths.has(path) && !omitted(path)) place(join(kit, path), join(destination, path));
for (const path of companyFiles) place(join(company, path), join(destination, path));
for (const [path, target] of addenda) {
  const file = join(destination, target);
  writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n\n# Company addendum from ${path}\n\n${readFileSync(join(company, path), 'utf8').trim()}\n`);
}

const summary = { replacements, omit: omissions, addenda: addenda.map(([path]) => path) };
if (summaryPath) writeFileSync(summaryPath, JSON.stringify(summary) + '\n');
console.log(`kit composed: ${kitFiles.length} kit files, ${Object.keys(replacements).length} replaced, ${addenda.length} addenda, ${companyFiles.length} company files`);
