import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, rename, rm } from "node:fs/promises";
import { basename, join, relative, isAbsolute } from "node:path";
import { convert } from "html-to-text";
import MarkdownIt from "markdown-it";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { privateStateDirectory } from "./private-state.js";

export type MailPart = {
  partId?: string; mimeType?: string; filename?: string; parts?: MailPart[];
  body?: { data?: string; attachmentId?: string; size?: number };
  headers?: { name: string; value: string }[];
};
export type MailFile = { name: string; mimeType: string; size: number; sha256: string; path: string; contentId?: string };
export type ReceivedFile = MailFile | { name: string; error: string };
type LoadPart = (attachmentId: string) => Promise<{ data: string }>;
export function mailHeader(part: MailPart, name: string) {
  return part.headers?.find(field => field.name.toLowerCase() === name.toLowerCase())?.value ?? "";
}
const filePart = (part: MailPart) => !!part.filename || /^attachment\b/i.test(mailHeader(part, "Content-Disposition"))
  || (!part.parts?.length && !!part.mimeType && !["text/plain", "text/html"].includes(part.mimeType));
export const safeFilename = (name: string) => basename(name.replace(/\\/g, "/")).replace(/[\x00-\x1f\x7f]/g, "_").replace(/^\.+/, "_").slice(0, 120) || "attachment";
const digest = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");
const inside = (root: string, path: string) => {
  const value = relative(root, path);
  return !isAbsolute(value) && value !== ".." && !value.startsWith("../");
};
async function data(part: MailPart, load: LoadPart) {
  const encoded = part.body?.data || (part.body?.attachmentId ? (await load(part.body.attachmentId)).data : "");
  return Buffer.from(encoded, "base64url");
}
function decode(bytes: Buffer, part: MailPart) {
  const charset = mailHeader(part, "Content-Type").match(/charset\s*=\s*["']?([^;"'\s]+)/i)?.[1] ?? "utf-8";
  try { return new TextDecoder(charset).decode(bytes); }
  catch { return bytes.toString("utf8"); }
}

/** Parse without rendering, executing markup or fetching images/links. */
export async function mailText(part: MailPart, load: LoadPart): Promise<string> {
  if (filePart(part)) return "";
  if (part.mimeType === "text/plain") return decode(await data(part, load), part);
  if (part.mimeType === "text/html") return convert(decode(await data(part, load), part), {
    wordwrap: false,
    selectors: [
      { selector: "script", format: "skip" }, { selector: "style", format: "skip" },
      { selector: "iframe", format: "skip" }, { selector: "object", format: "skip" },
      { selector: "img", format: "skip" },
    ],
  });
  const children = part.parts ?? [];
  if (part.mimeType === "multipart/alternative") {
    for (const child of [...children].sort((a, b) => Number(b.mimeType === "text/plain") - Number(a.mimeType === "text/plain"))) {
      const text = await mailText(child, load);
      if (text.trim()) return text;
    }
    return "";
  }
  const result = [];
  for (const child of children) {
    const text = await mailText(child, load);
    if (text.trim()) result.push(text);
  }
  return result.join("\n");
}

export function mailFiles(root: string, mailbox: string, address: string, key: string) {
  const directory = join(root, digest(`${mailbox}:${address}:${key}`));
  const outgoing = join(directory, "outgoing");
  async function prepare() {
    await privateStateDirectory(root);
    for (const path of [directory, outgoing, join(directory, "received"), join(directory, "frozen")]) {
      await privateStateDirectory(path);
      if (!inside(await realpath(root), await realpath(path))) throw new Error("Mail file directory escapes its private root.");
    }
  }
  async function save(folder: "received" | "frozen", name: string, bytes: Buffer, mimeType: string, contentId?: string): Promise<MailFile> {
    name = safeFilename(name);
    const sha256 = digest(bytes);
    const path = join(directory, folder, `${sha256}-${name}`);
    const temporary = join(directory, folder, `.staging-${randomUUID()}`);
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await rename(temporary, path);
    } finally { await rm(temporary, { force: true }); }
    const file = { name, mimeType, size: bytes.length, sha256, path, ...(contentId ? { contentId } : {}) };
    await read(file);
    return file;
  }
  async function read(file: MailFile) {
    if (!inside(await realpath(root), await realpath(file.path))) throw new Error("Mail attachment escapes its private root.");
    const handle = await open(file.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || (info.mode & 0o077)) throw new Error("Mail attachments must be private, owned regular files.");
      const bytes = await handle.readFile();
      if (bytes.length !== file.size || digest(bytes) !== file.sha256) throw new Error("Mail attachment changed after it was recorded.");
      return bytes;
    } finally { await handle.close(); }
  }
  async function receive(part: MailPart, load: LoadPart, maxBytes: number): Promise<ReceivedFile[]> {
    const files: ReceivedFile[] = [];
    let used = 0;
    async function visit(part: MailPart) {
      if (filePart(part)) {
        const name = safeFilename(part.filename || `inline-${part.partId ?? files.length}`);
        if ((part.body?.size ?? 0) > maxBytes - used) {
          files.push({ name, error: "Attachment exceeds the remaining per-message byte limit." }); return;
        }
        const bytes = await data(part, load);
        if (bytes.length > maxBytes - used) {
          files.push({ name, error: "Attachment exceeds the remaining per-message byte limit." }); return;
        }
        used += bytes.length;
        files.push(await save("received", name, bytes, part.mimeType ?? "application/octet-stream",
          mailHeader(part, "Content-ID").replace(/^<|>$/g, "") || undefined));
        return;
      }
      for (const child of part.parts ?? []) await visit(child);
    }
    await visit(part);
    return files;
  }
  async function attach(path: string, name: string | undefined, maxBytes: number): Promise<MailFile> {
    const canonical = await realpath(path);
    if (!isAbsolute(path) || !inside(await realpath(outgoing), canonical)) throw new Error("Create the requested file inside this email turn's outgoing directory first.");
    const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.() || info.size > maxBytes) throw new Error("Attachment must be an owned regular file within the per-message byte limit.");
      const bytes = await handle.readFile();
      if (bytes.length > maxBytes) throw new Error("Attachment exceeds the per-message byte limit.");
      return save("frozen", name ?? basename(path), bytes, "application/octet-stream");
    } finally { await handle.close(); }
  }
  return { prepare, receive, outgoing, attach, read };
}

const markdown = new MarkdownIt({ html: false, linkify: false });
// Replies never embed remote images or trackers supplied by model text.
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
export async function composeMail(options: {
  from: { name: string; address: string }; to: string; subject: string; messageId: string;
  inReplyTo: string; references: string; delivery: string; date: Date; text: string;
  attachments: { file: MailFile; bytes: Buffer }[];
}) {
  return new MailComposer({
    from: options.from, to: options.to, replyTo: options.from.address, subject: options.subject,
    date: options.date, messageId: options.messageId, inReplyTo: options.inReplyTo, references: options.references,
    headers: { "X-Dispatch-Delivery": options.delivery, "Auto-Submitted": "auto-replied", "X-Auto-Response-Suppress": "All" },
    text: options.text, html: markdown.render(options.text),
    attachments: options.attachments.map(({ file, bytes }) => ({
      filename: file.name, content: bytes, ...(file.mimeType === "application/octet-stream" ? {} : { contentType: file.mimeType }),
    })),
    disableFileAccess: true, disableUrlAccess: true,
  }).compile().build();
}
