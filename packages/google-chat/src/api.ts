import { createHash, createPrivateKey, sign } from "node:crypto";

export type GoogleCredentials = {
  type: "service_account"; project_id: string; client_email: string; private_key: string;
};
export class GoogleApiError extends Error {
  constructor(readonly status: number, readonly retryAfter: number) {
    super(`Google API request failed (HTTP ${status}).`);
  }
}
const chatScope = "https://www.googleapis.com/auth/chat.bot";
const pubsubScope = "https://www.googleapis.com/auth/pubsub";
export const messageId = (key: string) => `client-${createHash("sha256").update(key).digest("hex").slice(0, 56)}`;

/** Credentials are host-owned and never enter native conversation records. */
export class GoogleChatApi {
  private tokens = new Map<string, { value: string; expires: number }>();
  private refreshing = new Map<string, Promise<string>>();
  private key;
  constructor(readonly credentials: GoogleCredentials) {
    if (credentials.type !== "service_account" || !credentials.project_id ||
        !credentials.client_email?.endsWith(".iam.gserviceaccount.com"))
      throw new Error("Google Chat requires a project service account.");
    this.key = createPrivateKey(credentials.private_key);
  }
  private async token(scope: string): Promise<string> {
    const saved = this.tokens.get(scope);
    if (saved && saved.expires > Date.now() + 60_000) return saved.value;
    let pending = this.refreshing.get(scope);
    if (!pending) {
      pending = (async () => {
        const now = Math.floor(Date.now() / 1000);
        const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
        const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
          iss: this.credentials.client_email, scope, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600,
        })}`;
        const assertion = `${body}.${sign("RSA-SHA256", Buffer.from(body), this.key).toString("base64url")}`;
        const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST",
          body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
          signal: AbortSignal.timeout(30_000) });
        if (!response.ok) throw new GoogleApiError(response.status, 30_000);
        const result = await response.json() as { access_token: string; expires_in: number };
        if (!result.access_token || !Number.isFinite(result.expires_in)) throw new Error("Invalid Google token response.");
        this.tokens.set(scope, { value: result.access_token, expires: Date.now() + result.expires_in * 1000 });
        return result.access_token;
      })();
      this.refreshing.set(scope, pending);
      void pending.finally(() => this.refreshing.delete(scope)).catch(() => {});
    }
    return pending;
  }
  private async request<T>(api: "chat" | "pubsub", path: string, method = "GET", body?: unknown, signal?: AbortSignal): Promise<T> {
    const scope = api === "chat" ? chatScope : pubsubScope;
    const response = await fetch(`https://${api}.googleapis.com/v1/${path}`, {
      method, headers: { Authorization: `Bearer ${await this.token(scope)}`, "Content-Type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60_000)]) : AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      if (response.status === 401) this.tokens.delete(scope);
      const retry = Number(response.headers.get("retry-after"));
      throw new GoogleApiError(response.status, retry > 0 ? retry * 1000 : 30_000);
    }
    return await response.json() as T;
  }
  async verify(subscription: string) {
    const result = await this.request<{ name: string; topic: string }>("pubsub", subscription);
    if (result.name !== subscription || !result.topic.startsWith(`projects/${this.credentials.project_id}/topics/`))
      throw new Error("Google Chat subscription belongs to another project.");
  }
  pull(subscription: string, signal: AbortSignal) {
    return this.request<{ receivedMessages?: { ackId: string; message: { data: string; messageId: string } }[] }>(
      "pubsub", `${subscription}:pull`, "POST", { maxMessages: 100 }, signal);
  }
  acknowledge(subscription: string, ackIds: string[], signal?: AbortSignal) {
    return this.request("pubsub", `${subscription}:acknowledge`, "POST", { ackIds }, signal);
  }
  async message(space: string, thread: string, text: string, key: string, edit = false, signal?: AbortSignal) {
    const id = messageId(key);
    const name = `${space}/messages/${id}`;
    const body = { text, thread: { name: thread } };
    try {
      await this.request("chat", `${space}/messages?messageId=${id}&messageReplyOption=REPLY_MESSAGE_OR_FAIL`, "POST", body, signal);
    } catch (error) {
      if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
      // Client-assigned IDs reconcile an uncertain post without duplicate replies.
      if (edit) await this.request("chat", `${name}?updateMask=text`, "PATCH", { text }, signal);
    }
    return name;
  }
  async stopMessage(name: string, thread: string) {
    try { await this.request("chat", `${name}?updateMask=text`, "PATCH", { text: "Stopped." }); }
    catch (error) {
      if (!(error instanceof GoogleApiError) || error.status !== 404) throw error;
      const [space, id] = name.split("/messages/");
      try {
        await this.request("chat", `${space}/messages?messageId=${id}&messageReplyOption=REPLY_MESSAGE_OR_FAIL`, "POST",
          { text: "Stopped.", thread: { name: thread } });
      } catch (error) {
        if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
        await this.request("chat", `${name}?updateMask=text`, "PATCH", { text: "Stopped." });
      }
    }
  }
  async deleteMessage(name: string, signal?: AbortSignal) {
    try { await this.request("chat", name, "DELETE", undefined, signal); }
    catch (error) { if (!(error instanceof GoogleApiError) || error.status !== 404) throw error; }
  }
}

/** The API limit includes JSON bytes. Never split a Unicode code point. */
export function messageChunk(text: string, offset: number, thread: string): string {
  let result = "";
  let bytes = Buffer.byteLength(JSON.stringify({ text: "", thread: { name: thread } }));
  for (const point of text.slice(offset)) {
    const size = Buffer.byteLength(JSON.stringify(point)) - 2;
    if (bytes + size > 32_000) break;
    result += point; bytes += size;
  }
  return result;
}
