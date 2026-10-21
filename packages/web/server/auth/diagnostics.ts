/** Classify WebAuthn failures without retaining assertions, challenges or key material. */
export function passkeyVerificationFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  if (/^Unexpected (?:authentication|registration) response challenge /.test(message)) return "challenge_mismatch";
  if (/^(?:Detected|Unexpected) cross-origin |^Unexpected top origin /.test(message)) return "cross_origin_rejected";
  if (/^Unexpected (?:authentication|registration) response origin /.test(message)) return "origin_mismatch";
  if (error instanceof Error && error.name === "UnexpectedRPIDHash") return "rp_id_mismatch";
  if (/^Response counter value /.test(message)) return "counter_rejected";
  if (/^User verification (?:was )?required,/.test(message)) return "user_verification_missing";
  if (/^User not present during authentication$|^User presence was required,/.test(message)) return "user_presence_missing";
  if (error instanceof Error && error.name === "InvalidBackupFlags") return "backup_flags_invalid";
  if (/^Credential public key was missing numeric alg$|^Unexpected public key alg /.test(message)
    || (error instanceof Error && error.name === "PQCNotSupportedError")) return "algorithm_unsupported";
  return "invalid_passkey_response";
}

export function authenticationFailureContext(request: Request) {
  const trace = request.headers.get("x-amzn-trace-id")?.match(/(?:^|;)\s*Root=(1-[a-f0-9]{8}-[a-f0-9]{24})(?:;|$)/i)?.[1];
  return {
    userAgent: request.headers.get("user-agent")?.slice(0, 512) ?? null,
    ...(trace ? { trace } : {}),
  };
}
