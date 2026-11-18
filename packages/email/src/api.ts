import { readFile, stat } from "node:fs/promises";

export class GmailApiError extends Error {
  constructor(readonly status: number, path: string, readonly retryAt?: number) {
    super(`Gmail ${path.split("?")[0]} failed (${status}).${retryAt ? ` Retry after ${new Date(retryAt).toISOString()}.` : ""}`);
  }
}

/** Bind requests to one OAuth grant. The transport and read-only sources share the same client. */
export function gmailApi(credentialFile: string) {
  let token: { value: string; expires: number } | undefined;
  let refresh: Promise<string> | undefined;
  async function accessToken() {
    if (token && token.expires > Date.now() + 60_000) return token.value;
    return refresh ??= (async () => {
      const info = await stat(credentialFile);
      if ((info.mode & 0o077) || info.uid !== process.getuid?.()) throw new Error("Gmail credentials must be owner-only.");
      const credentials = JSON.parse(await readFile(credentialFile, "utf8"));
      const response = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST", signal: AbortSignal.timeout(30_000),
        body: new URLSearchParams({
          client_id: credentials.clientId, client_secret: credentials.clientSecret,
          refresh_token: credentials.refreshToken, grant_type: "refresh_token",
        }),
      });
      if (!response.ok) throw new Error(`Gmail OAuth refresh failed (${response.status}).`);
      const result = await response.json() as { access_token: string; expires_in: number };
      token = { value: result.access_token, expires: Date.now() + result.expires_in * 1000 };
      return token.value;
    })().finally(() => { refresh = undefined; });
  }
  async function api<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${path}`, {
      method: body === undefined ? "GET" : "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000),
      headers: { authorization: `Bearer ${await accessToken()}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (response.status === 401) token = undefined;
    if (!response.ok) {
      const retry = response.headers.get("retry-after");
      let retryAt = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Date.now() + Number(retry) * 1000 : Date.parse(retry)) : 0;
      if ([403, 429].includes(response.status)) {
        // Extract only Gmail's retry timestamp; never expose private error bodies.
        const body = await response.json().catch(() => null) as { error?: { message?: string } } | null;
        const message = body?.error?.message;
        const timestamp = typeof message === "string" ? message.match(/\bRetry after (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)/i)?.[1] : undefined;
        const parsed = timestamp ? Date.parse(timestamp) : NaN;
        if (Number.isFinite(parsed)) retryAt = Math.max(Number.isFinite(retryAt) ? retryAt : 0, parsed);
      }
      throw new GmailApiError(response.status, path, Number.isFinite(retryAt) && retryAt > Date.now() ? retryAt : undefined);
    }
    return await response.json() as T;
  }
  return api;
}
