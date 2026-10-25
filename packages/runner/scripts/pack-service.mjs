import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';

const [destination, ...archives] = process.argv.slice(2);
if (!destination || !archives.length) throw new Error('Usage: node pack-service.mjs OUTPUT.tar.gz RUNNER.tgz [ADAPTER.tgz ...]');
const output = resolve(destination);
const stage = await mkdtemp(join(tmpdir(), 'dispatch-service-'));
try {
  await mkdir(join(stage, 'artifacts'));
  const dependencies = {}, sources = [];
  for (const source of archives) {
    const archive = resolve(source);
    const manifest = JSON.parse(execFileSync('tar', ['-xOf', archive, 'package/package.json'], { encoding: 'utf8' }));
    if (dependencies[manifest.name]) throw new Error(`Duplicate package: ${manifest.name}`);
    const sha256 = createHash('sha256').update(await readFile(archive)).digest('hex');
    const file = `artifacts/${sha256}.tgz`;
    await copyFile(archive, join(stage, file));
    dependencies[manifest.name] = `file:${file}`;
    sources.push({ name: manifest.name, version: manifest.version, sha256 });
  }
  if (!dependencies['@dispatch/runner']) throw new Error('Include the Runner package archive.');
  await writeFile(join(stage, 'package.json'), JSON.stringify({ name: 'dispatch-service-installation', private: true, type: 'module', dependencies }, null, 2));
  execFileSync('npm', ['install', '--ignore-scripts', '--omit=dev'], { cwd: stage, stdio: 'inherit' });
  await writeFile(join(stage, 'installation.json'), JSON.stringify({
    node: process.version, platform: process.platform, arch: process.arch, sources,
  }, null, 2));
  await mkdir(dirname(output), { recursive: true });
  execFileSync('tar', ['-czf', output, '-C', stage, '.']);
  console.log(JSON.stringify({ artifact: output, sha256: createHash('sha256').update(await readFile(output)).digest('hex') }));
} finally { await rm(stage, { recursive: true, force: true }); }
