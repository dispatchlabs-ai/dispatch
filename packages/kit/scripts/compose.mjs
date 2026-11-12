#!/usr/bin/env node
// Composes one definitions root: the kit first, the company tree on top.
//   node scripts/compose.mjs KIT COMPANY DESTINATION [SUMMARY.json]
//   node scripts/compose.mjs status KIT COMPANY   what the kit changed for this company since `accept`
//   node scripts/compose.mjs accept KIT COMPANY   record the kit this company builds with in kit.lock.json
// A company file at a kit path needs a reason in the company's kit.json.
// agents/ROLE/company.md is appended to the kit's agents/ROLE/agent.md, and
// DIR/NAME.company.md to any other kit DIR/NAME.md. kit.json can also omit
// kit files or directories it does not want, each with a reason, set a kit
// role's model without replacing its agent.md, and change a kit role's message
// recipients, delegates and extensions without replacing its agent.ts.
// kit.lock.json records the kit's files, so a kit change to a file the company
// replaced is reported instead of passing unnoticed.
// Every problem is reported before the build fails.
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const args = process.argv.slice(2);
const command = ['status', 'accept'].includes(args[0]) ? args.shift() : 'compose';
const [kit, company, destination, summaryPath] = args;
if (!kit || !company || (command === 'compose' && !destination)) {
  throw new Error('Usage: compose.mjs KIT COMPANY DESTINATION [SUMMARY.json] | compose.mjs status KIT COMPANY | compose.mjs accept KIT COMPANY');
}

const declaration = 'kit.json';
const lockFile = 'kit.lock.json';
const addendum = 'company.md';
const kitDirectories = ['agents', 'skills', 'kit'];
const kitLicense = 'kit/LICENSE';
const roleFields = ['messages', 'delegates', 'extensions'];
const agentName = /^[a-z][a-z0-9-]*$/;
// A company module and the extension it exports, such as src/wiki-tools.ts#WikiTools.
const extensionReference = /^(?!\/)(?!.*(?:^|\/)\.\.?(?:\/|#))([\w./-]+)#([A-Za-z_$][\w$]*)$/;

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

const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const problems = [];
const kitFiles = [...list(kit, kitDirectories), kitLicense];
const kitPaths = new Set(kitFiles);
const kitFolders = new Set(kitFiles.flatMap(path => path.split('/').slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join('/'))));
const kitSource = path => join(kit, path === kitLicense ? 'LICENSE' : path);
const kitDigests = Object.fromEntries(kitFiles.map(path => {
  const source = kitSource(path);
  return [path, createHash('sha256').update(lstatSync(source).isSymbolicLink() ? readlinkSync(source) : readFileSync(source)).digest('hex')];
}));
const kitVersion = existsSync(join(kit, 'package.json')) ? JSON.parse(readFileSync(join(kit, 'package.json'), 'utf8')).version : 'unknown';
const companyFiles = list(company);
const companyPaths = new Set(companyFiles);

let replacements = {};
let omissions = {};
let models = {};
let roles = {};
if (companyPaths.has(declaration)) {
  let declared;
  try { declared = JSON.parse(readFileSync(join(company, declaration), 'utf8')); }
  catch (error) { problems.push(`${declaration} is not valid JSON: ${error.message}`); }
  if (declared !== undefined) {
    const sections = ['replacements', 'omit', 'models', 'roles'];
    if (!plain(declared) || Object.keys(declared).some(key => !sections.includes(key)) || sections.some(key => declared[key] !== undefined && !plain(declared[key]))) {
      problems.push(`${declaration} must be {"replacements": {"PATH": "REASON"}, "omit": {"PATH": "REASON"}, "models": {"ROLE": {"provider": "...", "id": "...", "thinking": "..."}}, "roles": {"ROLE": {"messages": [...], "delegates": [...], "extensions": [...]}}} and nothing else.`);
    } else { replacements = declared.replacements ?? {}; omissions = declared.omit ?? {}; models = declared.models ?? {}; roles = declared.roles ?? {}; }
  }
}
for (const [path, reason] of Object.entries(replacements)) {
  if (path === kitLicense) problems.push(`${declaration} cannot replace ${kitLicense}; retain the shared kit's license notice.`);
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

const modelLine = /^model:.*$/m;
for (const [role, model] of Object.entries(models)) {
  const path = `agents/${role}/agent.md`;
  const fields = model && typeof model === 'object' && !Array.isArray(model) ? Object.keys(model) : [];
  if (!fields.includes('provider') || !fields.includes('id') || fields.some(key => !['provider', 'id', 'thinking'].includes(key))
    || Object.values(model ?? {}).some(value => typeof value !== 'string' || !/^[\w./:@-]+$/.test(value))) {
    problems.push(`${declaration}: models.${role} must be {"provider": "...", "id": "...", "thinking": "..."} with plain names; thinking is optional.`);
  }
  if (!kitPaths.has(path)) problems.push(`${declaration} sets a model for ${role}, but the kit has no ${path}. Set a company agent's model in its own agent.md.`);
  else if (omitted(path)) problems.push(`${declaration} sets a model for ${role}, which it also omits. Keep one of the two.`);
  else if (path in replacements) problems.push(`${declaration} sets a model for ${role} and replaces ${path}. Put the model in the replacement.`);
  else if (!modelLine.test(readFileSync(join(kit, path), 'utf8').split('\n---')[0])) problems.push(`${path} has no model line to set.`);
}

// What the composed root will hold, for the names and modules a role change refers to.
const composed = path => companyPaths.has(path) || (kitPaths.has(path) && !omitted(path));
for (const [role, changes] of Object.entries(roles)) {
  const path = `agents/${role}/agent.ts`;
  const at = `${declaration}: roles.${role}`;
  if (!kitPaths.has(path)) { problems.push(`${declaration} changes the role ${role}, but the kit has no ${path}. Change a company agent in its own agent.ts.`); continue; }
  if (omitted(path)) problems.push(`${declaration} changes the role ${role}, which it also omits. Keep one of the two.`);
  else if (path in replacements) problems.push(`${declaration} changes the role ${role} and replaces ${path}. Put the change in the replacement, or remove the replacement.`);
  if (companyPaths.has(`agents/${role}/agent.kit.ts`)) problems.push(`agents/${role}/agent.kit.ts is where the composer keeps the kit's definition of a changed role. Rename the company file.`);
  if (!plain(changes) || !Object.keys(changes).length || Object.keys(changes).some(key => !roleFields.includes(key))) {
    problems.push(`${at} must set at least one of messages, delegates and extensions, and nothing else.`);
    continue;
  }
  for (const [field, change] of Object.entries(changes)) {
    const whole = Array.isArray(change);
    const parts = whole ? { whole: change } : plain(change) ? change : null;
    if (!parts || (!whole && (!Object.keys(parts).length || Object.keys(parts).some(key => !['add', 'remove'].includes(key))))
      || Object.values(parts).some(entries => !Array.isArray(entries) || entries.some(entry => typeof entry !== 'string'))) {
      problems.push(`${at}.${field} must be a list (the whole list) or {"add": [...], "remove": [...]} (changes to the kit's list).`);
      continue;
    }
    const entries = Object.values(parts).flat();
    if (new Set(entries).size !== entries.length) problems.push(`${at}.${field} names an entry twice.`);
    for (const [part, names] of Object.entries(parts)) for (const name of names) {
      if (field !== 'extensions') {
        if (!agentName.test(name)) problems.push(`${at}.${field}: ${JSON.stringify(name)} is not an agent name.`);
        else if (part !== 'remove' && !composed(`agents/${name}/agent.ts`)) problems.push(`${at}.${field} names ${name}, but neither the kit nor the company tree has agents/${name}/agent.ts.`);
      } else if (part === 'remove' || (part === 'whole' && !name.includes('#'))) {
        // The name of one of the kit role's own extensions; the role checks it when it loads.
        if (!name.trim() || name.includes('#')) problems.push(`${at}.extensions.${part}: ${JSON.stringify(name)} must be the name of one of the kit role's extensions, such as coding-tools.`);
      } else {
        const reference = extensionReference.exec(name);
        if (!reference) problems.push(`${at}.extensions: ${JSON.stringify(name)} must be MODULE#EXPORT, such as src/tools.ts#CompanyTools, with the module's path from the company root.`);
        else if (!composed(reference[1])) problems.push(`${at}.extensions names ${reference[1]}, but neither the kit nor the company tree has that file.`);
      }
    }
  }
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
    if (!(path in replacements)) problems.push(`${path} is a kit file. To replace it, declare it with a reason in ${declaration}: {"replacements": {"${path}": "why this company needs its own"}}. ${/^agents\/[^/]+\/agent\.ts$/.test(path)
      ? `To change the role's message recipients, delegates or extensions without replacing it, use "roles" in ${declaration}.`
      : `To add to a kit role without replacing it, use agents/ROLE/${addendum}.`}`);
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

// The kit's files as `accept` last recorded them. `accept` rewrites the record, so it does not read it.
let lock = null;
if (companyPaths.has(lockFile) && command !== 'accept') {
  try { lock = JSON.parse(readFileSync(join(company, lockFile), 'utf8')); } catch { lock = undefined; }
  if (!plain(lock) || typeof lock.version !== 'string' || !plain(lock.files) || Object.values(lock.files).some(value => typeof value !== 'string')) {
    problems.push(`${lockFile} is not what the kit's accept command writes. Run accept again.`);
    lock = null;
  }
}

if (problems.length) {
  console.error(`The kit and the company tree do not compose:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
  process.exit(1);
}

const replaced = Object.keys(replacements);
const review = {
  // Replaced files whose kit original changed since the record: the replacement may need the same change.
  changed: lock ? replaced.filter(path => path in lock.files && lock.files[path] !== kitDigests[path]) : [],
  unrecorded: replaced.filter(path => !lock || !(path in lock.files)),
};

if (command === 'accept') {
  writeFileSync(join(company, lockFile), JSON.stringify({ version: kitVersion, files: kitDigests }, null, 2) + '\n');
  console.log(`Recorded kit ${kitVersion} (${kitFiles.length} files) in ${lockFile}. Commit it with the change that moves the kit.`);
  process.exit(0);
}

if (command === 'status') {
  const section = (title, paths) => { if (paths.length) console.log(`\n${title}\n${paths.map(path => `  ${path}`).join('\n')}`); };
  const received = path => !omitted(path) && !(path in replacements);
  console.log(lock ? `Kit ${kitVersion}. ${lockFile} records kit ${lock.version}.` : `Kit ${kitVersion}. No ${lockFile}: nothing is recorded yet.`);
  section(`Replaced here and changed in the kit since ${lock?.version}. Compare packages/kit/PATH between the two Dispatch versions and carry over what applies:`, review.changed);
  section('Replaced here and not recorded, so a kit change to them would go unreported:', review.unrecorded);
  section('Replaced here, unchanged in the kit:', replaced.filter(path => !review.changed.includes(path) && !review.unrecorded.includes(path)));
  if (lock) {
    section(`Changed in the kit since ${lock.version} and received as is:`, kitFiles.filter(path => received(path) && path in lock.files && lock.files[path] !== kitDigests[path]));
    section(`New in the kit since ${lock.version}:`, kitFiles.filter(path => received(path) && !(path in lock.files)));
    section(`Removed from the kit since ${lock.version}:`, Object.keys(lock.files).filter(path => !kitPaths.has(path)));
  }
  section('Kit roles changed by roles in kit.json:', Object.entries(roles).map(([role, changes]) => `${role} (${Object.keys(changes).join(', ')})`));
  section('Omitted:', Object.keys(omissions));
  const pending = review.changed.length || review.unrecorded.length || !lock || lock.version !== kitVersion;
  console.log(pending ? '\nAfter checking the lists above, record this kit with the accept command.' : '\nNothing to check.');
  process.exit(0);
}

for (const path of review.changed) console.error(`warning: the kit's ${path} changed since kit ${lock.version}, which this company's replacement was last checked against. Compare packages/kit/${path} between Dispatch ${lock.version} and ${kitVersion}, carry over what applies, then record the check with the kit's accept command.`);
if (review.unrecorded.length) console.error(`warning: ${lockFile} does not record ${review.unrecorded.join(', ')}, so a later kit change to ${review.unrecorded.length > 1 ? 'these replaced files' : 'this replaced file'} would go unreported. Record the kit with its accept command.`);

// A changed role keeps the kit's definition beside a module that applies the change, so the
// definition's fingerprint covers both the kit's file and what the company changed.
const roleModule = (role, changes) => {
  const imports = [];
  const extension = entry => {
    if (!entry.includes('#')) return JSON.stringify(entry);
    const [, path, name] = extensionReference.exec(entry);
    imports.push(`import { ${name} as extension${imports.length + 1} } from "../../${path}";`);
    return `extension${imports.length}`;
  };
  const fields = roleFields.filter(field => field in changes).map(field => {
    const change = changes[field];
    const items = (entries, added) => `[${entries.map(field === 'extensions' && added ? extension : JSON.stringify).join(', ')}]`;
    return `  ${field}: ${Array.isArray(change) ? items(change, true)
      : `{ ${['add', 'remove'].filter(part => part in change).map(part => `${part}: ${items(change[part], part === 'add')}`).join(', ')} }`},`;
  });
  return [
    `// Written by the kit's composer. agent.kit.ts is the kit's agents/${role}/agent.ts (sha256 ${kitDigests[`agents/${role}/agent.ts`]});`,
    `// roles.${role} in the company's ${declaration} changes it. Edit ${declaration}, not this file.`,
    'import kit from "./agent.kit.ts";',
    'import { changeRole } from "../../kit/role.ts";',
    ...imports,
    '',
    `export default changeRole(${JSON.stringify(role)}, kit, {`,
    ...fields,
    '});',
    '',
  ].join('\n');
};

for (const path of kitFiles) {
  if (companyPaths.has(path) || omitted(path)) continue;
  const role = /^agents\/([^/]+)\/agent\.ts$/.exec(path)?.[1];
  if (role === undefined || !(role in roles)) { place(kitSource(path), join(destination, path)); continue; }
  place(kitSource(path), join(destination, `agents/${role}/agent.kit.ts`));
  writeFileSync(join(destination, path), roleModule(role, roles[role]));
}
// Addendum sources, the declaration and the record are build inputs: applied or checked here, recorded in the summary, not shipped.
const applied = new Set(addenda.map(([path]) => path));
for (const path of companyFiles) if (!applied.has(path) && path !== declaration && path !== lockFile) place(join(company, path), join(destination, path));
for (const [role, model] of Object.entries(models)) {
  const file = join(destination, `agents/${role}/agent.md`);
  const [head, ...rest] = readFileSync(file, 'utf8').split('\n---');
  const value = ['provider', 'id', 'thinking'].filter(key => key in model).map(key => `${key}: ${model[key]}`).join(', ');
  writeFileSync(file, [head.replace(modelLine, `model: { ${value} }`), ...rest].join('\n---'));
}
for (const [path, target] of addenda) {
  const file = join(destination, target);
  writeFileSync(file, `${readFileSync(file, 'utf8').trimEnd()}\n\n# Company addendum from ${path}\n\n${readFileSync(join(company, path), 'utf8').trim()}\n`);
}

const summary = { replacements, omit: omissions, models, roles, addenda: addenda.map(([path]) => path), review: { recorded: lock?.version ?? null, ...review } };
if (summaryPath) writeFileSync(summaryPath, JSON.stringify(summary) + '\n');
console.log(`kit composed: ${kitFiles.length} kit files, ${replaced.length} replaced, ${Object.keys(roles).length} roles changed, ${addenda.length} addenda, ${companyFiles.length} company files`);
