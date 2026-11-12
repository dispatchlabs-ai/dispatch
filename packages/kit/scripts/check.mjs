#!/usr/bin/env node
// Fails when kit files carry an identifier that belongs to one owner, company
// or host. The kit ships to every consumer, so its text names none of them.
//   node scripts/check.mjs [DIRECTORY]      (default: this package)
// Only generic shapes are matched. This file lists no private name, and a
// clean result does not replace reading the text.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] ?? fileURLToPath(new URL('../', import.meta.url));
const skipped = new Set(['.git', 'node_modules', 'dist']);
const textFile = /\.(md|ts|mts|mjs|js|json|ya?ml|txt|nix|sh|py)$|(^|\/)LICENSE$/;

// Names reserved for documentation, and the public sources the kit cites.
const reservedHost = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost)$/;
const publicHosts = new Set(['docs.slack.dev', 'github.com']);
const publicSourceOwners = new Set(['dispatchlabs-ai', 'earendil-works']);
const placeholderUsers = new Set(['user', 'u', 'example', 'operator', 'name', 'me', 'runner']);
const documentationAddress = /^(127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
const placeholderAccounts = new Set(['123456789012', '000000000000']);

const rules = [
  ['a home directory path', /\/(?:Users|home)\/([A-Za-z][\w.-]*)\//g,
    match => !placeholderUsers.has(match[1].toLowerCase())],
  ['an email address', /[\w.+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,})\b/gi,
    match => !reservedHost.test(match[1].toLowerCase())],
  ['a URL outside the reserved example domains', /\b[a-z][a-z0-9+.-]*:\/\/([^\s/:"'`<>)\]|]+)([^\s"'`<>)\]|]*)/gi,
    match => {
      const host = match[1].toLowerCase().replace(/^[^@]*@/, '');
      if (reservedHost.test(host) || documentationAddress.test(host)) return false;
      if (!publicHosts.has(host)) return true;
      return host === 'github.com' && !publicSourceOwners.has(match[2].split('/')[1]?.toLowerCase());
    }],
  ['a hostname outside the reserved example domains',
    /(?<![\w@/.-])((?:[a-z0-9-]+\.)+(?:com|org|net|io|me|ai|dev|app|co|us|uk|cloud|internal|local|lan|corp|home))(?!\.?[\w-])/gi,
    match => !reservedHost.test(match[1].toLowerCase()) && !publicHosts.has(match[1].toLowerCase())],
  ['an IP address', /(?<![\d.])(\d{1,3}(?:\.\d{1,3}){3})(?![\d.])/g,
    match => !documentationAddress.test(match[1])],
  ['a 12-digit account identifier', /(?<![\w.])(\d{12})(?![\w.])/g,
    match => !placeholderAccounts.has(match[1])],
  ['a cloud resource name', /\barn:aws[\w-]*:[^\s"'`]+/g, () => true],
  ['a chat workspace, channel or member identifier', /(?<![\w-])[TCUWDGB](?=[A-Z0-9]*\d)[A-Z0-9]{8,11}(?![\w-])/g, () => true],
  ['a unique identifier', /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, () => true],
  ['a credential', /\b(?:xox[abeoprs]-[\w-]{8,}|sk-[\w-]{16,}|AKIA[0-9A-Z]{16}|gh[opsu]_\w{20,})/g, () => true],
];

const files = [];
(function walk(directory) {
  for (const name of readdirSync(directory).sort()) {
    if (skipped.has(name)) continue;
    const path = join(directory, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (textFile.test(path)) files.push(path);
  }
})(root);

const problems = [];
for (const path of files) {
  readFileSync(path, 'utf8').split('\n').forEach((line, index) => {
    for (const [what, pattern, applies] of rules) {
      for (const match of line.matchAll(pattern)) {
        if (applies(match)) problems.push(`${relative(root, path)}:${index + 1}: ${what}: ${match[0]}`);
      }
    }
  });
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\n${problems.length} identifier(s) found. Kit text reads company context from the company's own AGENTS.md and factory.yaml; examples use example.com.`);
  process.exit(1);
}
console.log(`kit ok: ${files.length} files carry no owner, company or host identifier`);
