import { inflateRawSync, crc32 } from "node:zlib";
import { z } from "zod";
import type { PortableBundle } from "../src/shared/bundles.js";

export const BUNDLE_MAX_BYTES = 8 * 1024 * 1024;
const MAX_FILES = 201;
const MAX_FILE_BYTES = 512 * 1024;
export class BundleError extends Error { status = 400; }
const fail = (message: string): never => { throw new BundleError(message); };
const key = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(100);
const text = z.string().max(50_000);
const skill = z.object({ key, name: z.string().trim().min(1).max(100), description: z.string().trim().min(1).max(500), instructions: text }).strict();
const agent = z.object({ key, name: z.string().trim().min(1).max(100), description: z.string().max(500), instructions: text,
  executionBackend: z.enum(["pi", "claude-agent-sdk", "muse-code"]).optional(),
  provider: z.string().min(1).max(100), modelId: z.string().min(1).max(200),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh", "max"]),
  skills: z.array(key).max(50), capabilities: z.array(key).max(50), omittedConnections: z.number().int().min(0).max(1000),
}).strict();
export const bundleSchema = z.object({ formatVersion: z.literal(1), id: key, version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,99}$/),
  agents: z.array(agent).max(100), skills: z.array(skill).max(100),
}).strict();
export const bundleExportSchema = z.object({ id: key, version: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9.+-]{0,99}$/),
  agentIds: z.array(z.string().min(1).max(200)).max(100),
  skills: z.array(z.object({ id: z.string().uuid(), revision: z.number().int().positive() }).strict()).max(100),
}).strict();
function unique(values: string[]) { if (new Set(values).size !== values.length) fail("Bundle contains duplicate keys or references."); }
export function validateBundle(value: unknown): PortableBundle {
  const bundle = bundleSchema.parse(value);
  if (!bundle.agents.length && !bundle.skills.length) fail("Choose at least one agent or skill.");
  unique(bundle.agents.map(item => item.key)); unique(bundle.skills.map(item => item.key));
  const skills = new Set(bundle.skills.map(item => item.key));
  for (const item of bundle.agents) {
    unique(item.skills); unique(item.capabilities);
    if (item.skills.some(key => !skills.has(key))) fail("An assigned skill is missing from the bundle.");
  }
  for (const item of bundle.skills) if (!item.instructions.trim()) fail("Skill instructions cannot be empty.");
  if (Buffer.byteLength(JSON.stringify(bundle)) > BUNDLE_MAX_BYTES) fail("Bundle contents exceed 8 MiB.");
  return bundle;
}
const decoder = new TextDecoder("utf-8", { fatal: true });
function utf8(bytes: Uint8Array) { try { return decoder.decode(bytes); } catch { return fail("Bundle files must be valid UTF-8."); } }
function safePath(name: string) {
  if (!/^[a-zA-Z0-9_./-]+$/.test(name) || name.length > 240 || name.split("/").some(part => !part || part === "." || part === "..")) fail("Unsafe archive path.");
  return name;
}

/** Deliberately restricted ZIP reader: regular stored/deflated files, no extraction, ZIP64, encryption or descriptors. */
function readZip(bytes: Buffer): Map<string, string> {
  if (bytes.length < 22 || bytes.length > BUNDLE_MAX_BYTES) fail("ZIP must be no larger than 8 MiB.");
  const end = bytes.length - 22;
  if (bytes.readUInt32LE(end) !== 0x06054b50 || bytes.readUInt16LE(end + 20) !== 0) fail("ZIP comments and trailing data are unsupported.");
  const count = bytes.readUInt16LE(end + 10), start = bytes.readUInt32LE(end + 16);
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || count !== bytes.readUInt16LE(end + 8) || count < 1 || count > MAX_FILES || start + bytes.readUInt32LE(end + 12) !== end) fail("Unsupported ZIP directory.");
  const files = new Map<string, string>(); let cursor = start, localEnd = 0, total = 0;
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) fail("Invalid ZIP directory.");
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28), extra = bytes.readUInt16LE(cursor + 30), comment = bytes.readUInt16LE(cursor + 32);
    const offset = bytes.readUInt32LE(cursor + 42), mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if ((flags & ~0x800) || ![0, 8].includes(method) || extra || comment || bytes.readUInt16LE(cursor + 34) || ((mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000) || (bytes.readUInt32LE(cursor + 38) & 0x10)) fail("ZIP supports only regular stored or deflated files without extra fields.");
    if (cursor + 46 + nameLength > end || size > MAX_FILE_BYTES || (total += size) > BUNDLE_MAX_BYTES) fail("ZIP contents exceed bundle limits.");
    const name = safePath(utf8(bytes.subarray(cursor + 46, cursor + 46 + nameLength)));
    if (files.has(name)) fail("Duplicate ZIP path.");
    if (offset !== localEnd || offset + 30 > start || bytes.readUInt32LE(offset) !== 0x04034b50) fail("Invalid ZIP file offset.");
    const localName = bytes.readUInt16LE(offset + 26), localExtra = bytes.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + localName + localExtra, dataEnd = dataStart + compressed;
    if (dataEnd > start || localExtra || localName !== nameLength || utf8(bytes.subarray(offset + 30, dataStart)) !== name || bytes.readUInt16LE(offset + 6) !== flags || bytes.readUInt16LE(offset + 8) !== method || bytes.readUInt32LE(offset + 14) !== checksum || bytes.readUInt32LE(offset + 18) !== compressed || bytes.readUInt32LE(offset + 22) !== size) fail("ZIP headers disagree.");
    let data: Buffer;
    try { data = method === 0 ? bytes.subarray(dataStart, dataEnd) : inflateRawSync(bytes.subarray(dataStart, dataEnd), { maxOutputLength: MAX_FILE_BYTES }); }
    catch { return fail("Invalid or oversized compressed file."); }
    if (data.length !== size || crc32(data) !== checksum) fail("ZIP file checksum or size mismatch.");
    files.set(name, utf8(data)); localEnd = dataEnd; cursor += 46 + nameLength;
  }
  if (cursor !== end || localEnd !== start) fail("Unexpected ZIP data.");
  return files;
}
export function decodeBundle(bytes: Buffer): PortableBundle {
  const files = readZip(bytes); let value: unknown;
  try { value = JSON.parse(files.get("dispatch.json") ?? ""); } catch { return fail("Missing or invalid dispatch.json."); }
  const manifest = bundleSchema.parse(value);
  const used = new Set(["dispatch.json"]);
  for (const item of [...manifest.agents, ...manifest.skills]) {
    const path = safePath(item.instructions);
    if (!path.endsWith(".md") || !files.has(path)) fail("Missing Markdown instruction file.");
    used.add(path); item.instructions = files.get(path)!;
  }
  if (files.size !== used.size) fail("Bundle includes unsupported or unreferenced files.");
  return validateBundle(manifest);
}
export function encodeBundle(input: PortableBundle): Buffer {
  const bundle = validateBundle(input), files = new Map<string, string>();
  const entries = (kind: "agents" | "skills") => bundle[kind].map(item => {
    const path = `${kind}/${item.key}.md`; files.set(path, item.instructions); return { ...item, instructions: path };
  });
  const manifest = { ...bundle, agents: entries("agents"), skills: entries("skills") };
  files.set("dispatch.json", JSON.stringify(manifest, null, 2) + "\n");
  const locals: Buffer[] = [], directory: Buffer[] = []; let offset = 0;
  for (const [path, text] of files) {
    const name = Buffer.from(path), data = Buffer.from(text), checksum = crc32(data);
    if (data.length > MAX_FILE_BYTES) fail("Bundle file exceeds 512 KiB.");
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(checksum, 14); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(checksum, 16); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(name.length, 28); central.writeUInt32LE(offset, 42);
    locals.push(local, name, data); directory.push(central, name); offset += local.length + name.length + data.length;
  }
  const dir = Buffer.concat(directory), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  const result = Buffer.concat([...locals, dir, end]); if (result.length > BUNDLE_MAX_BYTES) fail("Bundle exceeds 8 MiB."); return result;
}
