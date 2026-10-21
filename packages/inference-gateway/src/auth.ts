import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { DeferredHandle } from "@earendil-works/pi-ai";
import { z } from "zod";
import { HttpError, type GatewayConfig, type Principal } from "./config.js";
import { audienceHeader, identityBody, identityHost } from "./identity.js";
const proofSchema = z.object({ headers: z.record(z.string(), z.string()) }).strict();

export class GatewayAuth {
  constructor(private readonly config: GatewayConfig, private readonly key: Buffer) {
    if (key.length !== 32) throw new Error("The session signing secret must contain 32 bytes");
  }

  async exchange(value: unknown, signal: AbortSignal): Promise<{ token: string; expiresAt: number }> {
    const parsed = proofSchema.safeParse(value);
    if (!parsed.success) throw new HttpError(401, "invalid_identity_proof");
    const headers = parsed.data.headers;
    const allowed = ["host", "content-type", "authorization", "x-amz-date", "x-amz-security-token", audienceHeader];
    if (Object.keys(headers).some((name) => !allowed.includes(name)) || headers.host !== identityHost || headers[audienceHeader] !== this.config.audience || headers["content-type"] !== "application/x-www-form-urlencoded") {
      throw new HttpError(401, "invalid_identity_proof");
    }
    const authorization = /^AWS4-HMAC-SHA256 Credential=([A-Z0-9]+)\/(\d{8})\/us-east-1\/sts\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/.exec(headers.authorization ?? "");
    const signed = authorization?.[3]?.split(";") ?? [];
    if (!["host", "x-amz-date", audienceHeader].every((name) => signed.includes(name))) throw new HttpError(401, "invalid_identity_proof");
    const date = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(headers["x-amz-date"] ?? "");
    const time = date ? Date.parse(`${date[1]}-${date[2]}-${date[3]}T${date[4]}:${date[5]}:${date[6]}Z`) : NaN;
    if (!Number.isFinite(time) || Math.abs(Date.now() - time) > 60_000) throw new HttpError(401, "expired_identity_proof");
    // The caller supplies only signed headers. Destination, method and body are fixed here.
    const response = await fetch(`https://${identityHost}/`, {
      method: "POST", headers, body: identityBody, redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw new HttpError(401, "identity_verification_failed");
    const xml = await response.text();
    const account = /<Account>(\d{12})<\/Account>/.exec(xml)?.[1];
    const arn = /<Arn>([^<]+)<\/Arn>/.exec(xml)?.[1];
    const roleId = /<UserId>(AROA[A-Z0-9]+):[^<]+<\/UserId>/.exec(xml)?.[1];
    if (!account || !arn?.startsWith(`arn:aws:sts::${account}:assumed-role/`) || !roleId) throw new HttpError(403, "principal_not_allowed");
    const principal = this.config.principals.find((item) => item.aws.accountId === account && item.aws.roleId === roleId);
    if (!principal) throw new HttpError(403, "principal_not_allowed");
    const expiresAt = Date.now() + 10 * 60_000;
    const body = Buffer.from(JSON.stringify({ sub: principal.id, aud: this.config.audience, exp: expiresAt })).toString("base64url");
    return { token: `${body}.${this.sign(body)}`, expiresAt };
  }

  private sign(body: string): string { return createHmac("sha256", this.key).update(`session:${body}`).digest("base64url"); }

  verify(authorization: string | undefined): Principal {
    const token = authorization?.match(/^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/)?.[1];
    if (!token) throw new HttpError(401, "unauthorized");
    const [body, signature] = token.split(".");
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(signature);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new HttpError(401, "unauthorized");
    let claim: { sub?: unknown; aud?: unknown; exp?: unknown };
    try { claim = JSON.parse(Buffer.from(body, "base64url").toString()); } catch { throw new HttpError(401, "unauthorized"); }
    if (claim.aud !== this.config.audience || typeof claim.exp !== "number" || claim.exp <= Date.now()) throw new HttpError(401, "unauthorized");
    const principal = this.config.principals.find((item) => item.id === claim.sub);
    if (!principal) throw new HttpError(403, "principal_not_allowed");
    return principal;
  }

  seal(handle: DeferredHandle, principal: string, connection: string): DeferredHandle {
    const nonce = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(Buffer.from(`${this.config.audience}:${principal}:${connection}:${handle.modelId}`));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(handle)), cipher.final()]);
    return { provider: connection, modelId: handle.modelId, api: handle.api, id: Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url"), expiresAt: handle.expiresAt, pollAfterMs: handle.pollAfterMs };
  }

  unseal(handle: DeferredHandle, principal: string, connection: string, model: string): DeferredHandle {
    try {
      if (handle.provider !== connection || handle.modelId !== model) throw new Error();
      const data = Buffer.from(handle.id, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", this.key, data.subarray(0, 12));
      decipher.setAuthTag(data.subarray(12, 28));
      decipher.setAAD(Buffer.from(`${this.config.audience}:${principal}:${connection}:${model}`));
      const result: DeferredHandle = JSON.parse(Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString());
      if (result.expiresAt && result.expiresAt <= Date.now()) throw new Error();
      return result;
    } catch { throw new HttpError(403, "invalid_deferred_handle"); }
  }
}
