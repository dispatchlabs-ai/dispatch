import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";
import { audienceHeader, identityBody, identityHost } from "./identity.js";
import { gatewayOrigin } from "./config.js";
import type { GatewayAuthorization } from "./client.js";

/** Uses the standard AWS credential chain, including EC2 instance roles. No provider key enters the workload. */
export function awsGatewayAuthorization(url: string): GatewayAuthorization {
  const audience = gatewayOrigin(url);
  const signer = new SignatureV4({ credentials: fromNodeProviderChain(), region: "us-east-1", service: "sts", sha256: Sha256, applyChecksum: false });
  let current: { token: string; expiresAt: number } | undefined;
  let pending: Promise<string> | undefined;
  return async ({ forceRefresh = false, signal } = {}) => {
    signal?.throwIfAborted();
    if (!forceRefresh && current && current.expiresAt > Date.now() + 60_000) return current.token;
    if (!pending) {
      pending = (async () => {
      const proof = await signer.sign(new HttpRequest({
        protocol: "https:", hostname: identityHost, method: "POST", path: "/", body: identityBody,
        headers: { host: identityHost, "content-type": "application/x-www-form-urlencoded", [audienceHeader]: audience },
      }));
      const response = await fetch(`${audience}/v1/auth/aws`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ headers: proof.headers }),
        redirect: "error", signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`Gateway AWS authentication failed (${response.status})`);
      const value = await response.json() as { token?: unknown; expiresAt?: unknown };
      if (typeof value.token !== "string" || typeof value.expiresAt !== "number") throw new Error("Invalid gateway authentication response");
      current = { token: value.token, expiresAt: value.expiresAt };
      return current.token;
      })();
      void pending.then(() => { pending = undefined; }, () => { pending = undefined; });
    }
    if (!signal) return pending;
    let abort: () => void = () => {};
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () => reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try { return await Promise.race([pending, cancelled]); } finally { signal.removeEventListener("abort", abort); }
  };
}
