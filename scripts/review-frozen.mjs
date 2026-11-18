/**
 * Replay a frozen Dispatch review with Pi Code Mode. From a fresh checkout, run
 * `npm ci` and `npm run build -w @dispatch/runner` before invoking this script.
 * Each review gets a new output directory with its report and native usage receipts.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BACKGROUND_CONTEXT as ctx } from '@earendil-works/chord/context';
import { createModels } from '@earendil-works/pi-ai/models';
import { CodemodeSandbox } from '@earendil-works/pi-codemode';
import { AssistantEntry, Harness, createRegistry, defineExtension, defineTool } from '@earendil-works/pi-durable';
import { createCodemodeExtension } from '@earendil-works/pi-durable/codemode';
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node';
import { Type } from 'typebox';
import { loadAgent } from '../packages/runner/dist/definition.js';
import { readHostConfig } from '../packages/runner/dist/host-config.js';
import { hostModels } from '../packages/runner/dist/host-models.js';
import { privateStateDirectory, privateStateFiles } from '../packages/runner/dist/private-state.js';
import { serviceSettings } from '../packages/runner/dist/settings.js';

const [hostFile, agentName, evidenceFile, directory, earlierFile, ...extra] = process.argv.slice(2);
if (!directory || extra.length) throw new Error('Usage: node scripts/review-frozen.mjs <host.json> <agent> <evidence.ndjson> <new-output-directory> [earlier.ndjson]');
const evidence = await readFile(evidenceFile, 'utf8');
const { run, coverage } = JSON.parse(evidence.slice(0, evidence.indexOf('\n')));
const rows = [];
const conversations = new Map();

function addRow(section, conversation, type, value) {
  const summary = { row: rows.length, section, conversation, type };
  if (value.entry !== undefined) summary.entry = value.entry;
  if (value.task !== undefined) summary.task = value.task;
  if (value.document !== undefined) summary.document = value.document;
  if (value.kind) summary.kind = value.kind;
  if (value.outcome) summary.status = value.outcome.status;
  const labels = (value.messages ?? []).flatMap(message => {
    if (message.role === 'toolResult') return [message.tool + (message.error ? ' (error)' : '')];
    return Array.isArray(message.content) ? message.content.flatMap(part => part?.toolCall ?? []) : [];
  });
  if (labels.length) summary.tools = labels;
  rows.push({ summary, value, source: JSON.stringify(value) });
  if (section === 'earlier') return;
  let item = conversations.get(conversation);
  if (!item) conversations.set(conversation, item = { conversation, entries: 0, inputs: [], answers: [], errors: [], tasks: 0 });
  if (type === 'task') item.tasks++;
  if (type !== 'entry') return;
  item.entries++;
  for (const m of value.messages ?? []) {
    if (m.role === 'user') item.inputs.push(value.entry);
    if (m.role === 'assistant' && m.stop === 'stop') item.answers.push(value.entry);
    if (m.role === 'toolResult' && m.error) item.errors.push(value.entry);
  }
}

// Split snapshot envelopes into individually addressable records without dropping their contents.
function indexSnapshot(source, section) {
  let conversation = run.conversation;
  let child;
  for (const line of source.split('\n')) {
    if (!line) continue;
    if (line.startsWith('Conversation ')) { conversation = Number(line.slice('Conversation '.length)); continue; }
    const value = JSON.parse(line);
    if (value.entry !== undefined) { addRow(section, conversation, 'entry', value); continue; }
    if (value.child !== undefined) child = value.child;
    const owner = value.child ?? (value.childReceipts ? child : conversation);
    const { documentsAtStart, documentsAtEnd, tasks, receipts, childReceipts, ...rest } = value;
    if (Object.keys(rest).length) addRow(section, owner, 'metadata', rest);
    for (const [type, items] of Object.entries({ documentsAtStart, documentsAtEnd, tasks, receipts, childReceipts })) {
      for (const item of items ?? []) addRow(section, owner, type === 'tasks' ? 'task' : type, item);
    }
  }
}

indexSnapshot(evidence, 'run');
const earlier = earlierFile ? await readFile(earlierFile, 'utf8') : undefined;
if (earlier !== undefined) indexSnapshot(earlier, 'earlier');
const index = defineTool({
  name: 'trace_index', callers: ['tools'], replay: 'safe',
  description: 'Find snapshot rows by case-insensitive literal anywhere in their JSON, conversation, or section. Returns row numbers, IDs, kind, tool names, outcome status and a short match excerpt. Filter and aggregate the array inside Code Mode.',
  parameters: Type.Object({ contains: Type.Optional(Type.String()), conversation: Type.Optional(Type.Integer()), section: Type.Optional(Type.Union([Type.Literal('run'), Type.Literal('earlier')])) }),
  structuredOutputSchema: Type.Array(Type.Object({}, { additionalProperties: true })),
  async execute({ contains, conversation, section = 'run' }) {
    const needle = contains?.toLowerCase();
    const found = [];
    for (const { summary, source } of rows) {
      if (summary.section !== section || (conversation !== undefined && conversation !== summary.conversation)) continue;
      if (!needle) { found.push(summary); continue; }
      const at = source.toLowerCase().indexOf(needle);
      if (at >= 0) found.push({ ...summary, match: source.slice(Math.max(0, at - 80), at + needle.length + 100) });
    }
    return { output: [], structuredOutput: found };
  },
});
const read = defineTool({
  name: 'trace_read', callers: ['tools'], replay: 'safe',
  description: 'Read complete original records for selected trace_index row numbers, in order. Each element has row, conversation and value (including raw messages, arguments, results or document fields). Select useful fields in the script before printing.',
  parameters: Type.Object({ rows: Type.Array(Type.Integer({ minimum: 0 })) }),
  structuredOutputSchema: Type.Array(Type.Object({}, { additionalProperties: true })),
  async execute({ rows: selected }) {
    const values = selected.map(row => {
      if (!rows[row]) throw new Error(`No trace row ${row}.`);
      return { row, conversation: rows[row].summary.conversation, value: rows[row].value };
    });
    return { output: [], structuredOutput: values };
  },
});

const config = await readHostConfig(hostFile);
const agent = await loadAgent(config.root, agentName);
const instructions = await readFile(new URL('../packages/runner/prompts/run-review.md', import.meta.url), 'utf8');
const prompt = `Evaluate ${agent.id}, conversation ${run.conversation}, entries ${run.first} through ${run.last}, answer ${run.answer}.\n${coverage}\nEarlier snapshot: ${earlier === undefined ? 'unavailable' : 'supplied'}.\nConversation index: ${JSON.stringify([...conversations.values()])}\nUse Code Mode to inspect the frozen evidence. Start with the assignments, governing instructions and final answers. Check them against original calls, results, terminal receipts and child runs. Search for contradictions and follow errors through recovery. Inspect related records together in each script and print only the evidence needed to form a judgment. Cite original IDs in the final review.`;
const models = createModels({ authContext: { env: async () => undefined, fileExists: async () => false } });
const connection = hostModels(config, config.cwd);
await mkdir(directory, { mode: 0o700 });
await privateStateDirectory(directory);
await privateStateFiles(directory);
const storage = await openNodeSqliteStorage(join(directory, 'session.sqlite'));
let harness;
try {
  await connection.connect(models);
  const registry = createRegistry();
  const trace = defineExtension({ name: 'dispatch.frozen-evidence', tools: [index, read] });
  const code = createCodemodeExtension({ sandbox: new CodemodeSandbox(), models: false });
  registry.install(trace);
  registry.install(code);
  harness = await Harness.open(storage, { registry, models, settings: serviceSettings(config, models) }, ctx);
  const conversation = await harness.root(ctx, { agent: { instructions, extensions: [trace, code], model: { provider: agent.model.provider, modelId: agent.model.id }, thinkingLevel: agent.model.thinking } });
  const sha256 = text => createHash('sha256').update(text).digest('hex');
  await writeFile(join(directory, 'replay.json'), JSON.stringify({ run, model: agent.model, evidenceSha256: sha256(evidence), earlierSha256: earlier === undefined ? null : sha256(earlier), instructionsSha256: sha256(instructions), conversation: conversation.id }, null, 2), { mode: 0o600 });
  const submission = await conversation.submit({ type: 'input', requestId: 'review', content: prompt }, ctx);
  const receipt = await submission.wait(ctx);
  if (receipt.status !== 'done') throw new Error(`Review failed: ${JSON.stringify(receipt)}`);
  const entry = await conversation.commit(tx => tx.entry(AssistantEntry, receipt.answer), ctx);
  const answer = entry?.model?.[0];
  const text = answer?.content?.filter(part => part.type === 'text').map(part => part.text).join('\n').trim();
  if (answer?.stopReason !== 'stop' || !text) throw new Error(`Review returned an incomplete answer (${answer?.stopReason}).`);
  await writeFile(join(directory, 'review.md'), text + '\n', { mode: 0o600 });
} finally {
  try { if (harness) await harness.close(ctx); else await storage.close(ctx); }
  finally { await connection.close(); }
}
