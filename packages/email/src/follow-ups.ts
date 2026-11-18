import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { FollowUpMessage, FollowUpSource } from "@dispatch/runner/follow-ups";
import { gmailApi } from "./api.js";
import { mailHeader, mailText, type MailPart } from "./content.js";

type Message = { id: string; threadId: string; internalDate: string; labelIds?: string[]; payload: MailPart };
type Account = { mailbox: string; credentialFile: string };

function filenames(part: MailPart): string[] {
  return [...(part.filename ? [part.filename] : []), ...(part.parts ?? []).flatMap(filenames)];
}

/** Private account aliases remain stable across installations and saved follow-up cases. */
export function gmailFollowUpSources(options: { accountsFile: string }): Record<"mail-thread" | "mail-search", FollowUpSource> {
  const clients = new Map<string, ReturnType<typeof gmailApi>>();
  async function account(key: string, signal: AbortSignal) {
    const split = key.indexOf("/");
    const alias = key.slice(0, split), value = key.slice(split + 1).trim();
    if (split < 1 || !value) throw new Error("Use account/threadId or account/search terms.");
    const accounts: Record<string, Account> = JSON.parse(await readFile(options.accountsFile, { encoding: "utf8", signal }));
    const selected = Object.hasOwn(accounts, alias) && accounts[alias];
    if (!selected || !selected.mailbox || !selected.credentialFile) throw new Error("Gmail account is unavailable: " + alias);
    const path = resolve(dirname(options.accountsFile), selected.credentialFile);
    let api = clients.get(path);
    if (!api) { api = gmailApi(path); clients.set(path, api); }
    const get = <T>(path: string) => api<T>(path, undefined, signal);
    const profile = await get<{ emailAddress: string }>("profile");
    if (profile.emailAddress.toLowerCase() !== selected.mailbox.toLowerCase()) throw new Error("Gmail OAuth grant belongs to another mailbox.");
    return { alias, value, mailbox: profile.emailAddress, get };
  }
  async function thread(a: Awaited<ReturnType<typeof account>>, id: string, since: number): Promise<FollowUpMessage[]> {
    const data = await a.get<{ id: string; messages: Message[] }>("threads/" + encodeURIComponent(id) + "?format=full");
    if (data.id !== id || !Array.isArray(data.messages) || !data.messages.length) throw new Error("Gmail returned an incomplete thread.");
    const result: FollowUpMessage[] = [];
    for (const m of data.messages) {
      if (m.threadId !== id || !m.id || !m.internalDate || !Number.isFinite(Number(m.internalDate)) || !m.payload)
        throw new Error("Gmail returned an incomplete message.");
      const at = Number(m.internalDate);
      if (at < since || m.labelIds?.includes("DRAFT")) continue;
      const subject = mailHeader(m.payload, "Subject");
      const body = await mailText(m.payload, part => a.get("messages/" + encodeURIComponent(m.id) + "/attachments/" + encodeURIComponent(part)));
      const files = filenames(m.payload);
      const submitted = mailHeader(m.payload, "Auto-Submitted").trim();
      result.push({ id: ["mail", a.alias, m.id].join(":"), at, author: mailHeader(m.payload, "From"),
        text: [subject, body.trim(), ...(files.length ? ["Attached: " + files.join(", ")] : [])].filter(Boolean).join("\n\n"),
        link: "https://mail.google.com/mail/u/" + encodeURIComponent(a.mailbox) + "/#all/" + encodeURIComponent(id),
        outbound: !!m.labelIds?.includes("SENT"),
        automatic: (!!submitted && !/^no(?:\s*;|$)/i.test(submitted)) || /^(?:automatic reply|auto(?:matic)?[- ]response|out[- ]of[- ]office)\s*:/i.test(subject) });
    }
    return result;
  }
  async function* threadIds(a: Awaited<ReturnType<typeof account>>, query: string) {
    const pages = new Set<string>();
    let token: string | undefined;
    do {
      const params = new URLSearchParams({ q: query, maxResults: "500", includeSpamTrash: "true", fields: "nextPageToken,threads(id)" });
      if (token) params.set("pageToken", token);
      const page = await a.get<{ threads?: { id: string }[]; nextPageToken?: string }>("threads?" + params);
      for (const item of page.threads ?? []) {
        if (!item.id) throw new Error("Gmail search returned a thread without an ID.");
        yield item.id;
      }
      token = page.nextPageToken;
      if (token && pages.has(token)) throw new Error("Gmail search pagination did not advance.");
      if (token) pages.add(token);
    } while (token);
  }
  return {
    "mail-thread": { description: "Gmail account/threadId", async read(key, since, signal) {
      const a = await account(key, signal);
      return thread(a, a.value, since);
    } },
    "mail-search": { description: "Gmail account/search query, across all folders", async read(key, since, signal) {
      const a = await account(key, signal);
      const matching = new Set<string>();
      for await (const id of threadIds(a, a.value)) matching.add(id);
      const messages: FollowUpMessage[] = [];
      // An older message can match the query while only its new reply qualifies.
      // Intersect thread IDs before downloading message bodies.
      if (matching.size) {
        const after = Math.floor(since / 1000) - 1;
        for await (const id of threadIds(a, after > 0 ? "after:" + after : "")) {
          if (matching.delete(id)) messages.push(...await thread(a, id, since));
          if (!matching.size) break;
        }
      }
      return messages;
    } },
  };
}
