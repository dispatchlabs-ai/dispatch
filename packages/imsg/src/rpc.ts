import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { basename } from "node:path";
import type { MessagePart } from "./text.js";

export type RpcCommand = { command?: string; args?: string[] };
export type Chat = { id: number; guid: string; service: string; is_group: boolean; participants: string[] };
export type Message = {
  id: number; guid: string; chat_id: number; chat_guid?: string; sender: string; is_from_me: boolean;
  text?: string; is_reaction?: boolean; unsent_at?: string;
  attachments?: { transfer_name?: string; filename?: string; original_path?: string }[];
};
export function matchesPart(row: Message, part: MessagePart) {
  if (!row.is_from_me || !row.guid) return false;
  if ("text" in part) return row.text === part.text;
  return row.attachments?.some(a => [a.transfer_name, a.filename, a.original_path].some(path => path && basename(path) === part.table.name));
}
export type Page = { messages: Message[]; next_rowid: number; has_more: boolean };

export class RpcError extends Error {
  constructor(readonly code: number, readonly data?: { disposition?: string; retry_safe?: boolean }) {
    super(`imsg RPC error ${code}`);
  }
}

/** One imsg rpc stdio session. Losing the pipe rejects every outstanding call,
 * including mutations whose outcome the caller must reconcile. */
export class MessagesRpc {
  stagesFiles = false;
  private readonly child;
  private sequence = 0;
  private failure?: Error;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  constructor(options: RpcCommand, wake: () => void) {
    this.child = spawn(options.command ?? "imsg", options.args ?? ["rpc"], { stdio: ["pipe", "pipe", "inherit"] });
    const fail = (error: Error) => {
      if (this.failure) return;
      this.failure = error;
      for (const waiter of this.pending.values()) waiter.reject(error);
      this.pending.clear();
      this.child.kill();
      wake();
    };
    this.child.on("error", fail);
    this.child.stdin.on("error", fail);
    this.child.on("close", () => fail(new Error("Messages RPC disconnected.")));
    const lines = createInterface({ input: this.child.stdout });
    lines.on("line", line => {
      try {
        const packet = JSON.parse(line);
        if (packet.jsonrpc !== "2.0") throw new Error("Invalid Messages RPC frame.");
        if (packet.id !== undefined) {
          const waiter = this.pending.get(packet.id);
          if (!waiter) return;
          this.pending.delete(packet.id);
          if (packet.error) waiter.reject(new RpcError(packet.error.code, packet.error.data));
          else waiter.resolve(packet.result);
        } else if (packet.method === "watch.overflow" || packet.method === "watch.error") {
          fail(new Error("Messages watch ended. Resuming from the saved cursor."));
        } else if (packet.method === "message") wake();
      } catch (error) { fail(error instanceof Error ? error : new Error("Invalid Messages RPC output.")); }
    });
    lines.on("close", () => fail(new Error("Messages RPC output closed.")));
  }

  async call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.failure) throw this.failure;
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject });
      this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  after(since: number, chatId?: number, attachments = false) {
    return this.call<Page>("messages.after", { since_rowid: since, limit: 500, ...(chatId ? { chat_id: chatId } : {}), ...(attachments ? { attachments: true } : {}) });
  }

  close() { this.child.stdin.end(); this.child.kill(); }
}

export async function scan(rpc: MessagesRpc, since: number, page: (value: Page) => Promise<void>, chatId?: number, attachments = false) {
  for (;;) {
    const result = await rpc.after(since, chatId, attachments);
    if (!Number.isSafeInteger(result.next_rowid) || result.next_rowid < since || (result.has_more && result.next_rowid === since))
      throw new Error("Messages returned an invalid replay cursor.");
    await page(result);
    since = result.next_rowid;
    if (!result.has_more) return since;
  }
}
