// Creates new example configuration only. Does not start services or touch existing state.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
const output = resolve(process.argv[2] ?? '.local/chat-example');
const source = resolve(import.meta.dirname);
await mkdir(output, { recursive: true, mode: 0o700 });
const file = async (name, value) => writeFile(`${output}/${name}`, typeof value === 'string' ? value : JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
await mkdir(`${output}/instances`, { mode: 0o700 });
await mkdir(`${output}/worker`, { mode: 0o700 });
const host = { cwd: output, modelProviders: [{ module: `${source}/provider.mjs`, export: 'exampleProvider' }] };
await file('worker-token', randomBytes(32).toString('hex'));
await file('owner.json', { root: `${source}/definitions`, stateRoot: `${output}/instances`, socket: `${output}/agent.sock`, ...host });
await file('native.json', { service: { socket: `${output}/agent.sock`, sourceId: 'example', label: 'Example' } });
await file('central.json', { databaseUrlFile: `${output}/database-url`, workerPort: 4321, runs: [{ id: 'example', tokenFile: `${output}/worker-token`, agents: [{ id: 'helper', description: 'Synthetic local demonstration agent' }] }] });
await file('worker.json', { service: 'http://127.0.0.1:4321', allowLoopback: true, run: 'example', tokenFile: `${output}/worker-token`, definitionsRoot: `${source}/definitions`, stateRoot: `${output}/worker`, names: ['helper'], host });
console.log(`Created example configuration in ${output}. See examples/chat/README.md; nothing was started.`);
