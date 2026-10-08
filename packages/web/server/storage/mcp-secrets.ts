import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";

const sealSchema = z.tuple([z.string(), z.string(), z.string()]);
const envelopeSchema = z.object({ version: z.literal(1), key: sealSchema, value: sealSchema }).strict();

/** MCP-only envelope encryption; context includes installation and immutable record binding. */
export function encryptMcpSecret(value: string, root: Buffer, context: string[]): string {
  const dataKey = randomBytes(32);
  const seal = (value: Buffer, key: Buffer, purpose: string) => {
    const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(Buffer.from(JSON.stringify(["dispatch-mcp:v1", ...context, purpose])));
    const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
    return [nonce.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")];
  };
  try { return JSON.stringify({ version: 1, key: seal(dataKey, root, "key"), value: seal(Buffer.from(value), dataKey, "value") }); }
  finally { dataKey.fill(0); }
}

export function decryptMcpSecret(value: string, root: Buffer, context: string[]): string {
  try {
    const envelope = envelopeSchema.parse(JSON.parse(value));
    const unseal = (parts: string[], key: Buffer, purpose: string) => {
      const [nonce, tag, ciphertext] = parts.map(part => Buffer.from(part, "base64url"));
      if (nonce!.length !== 12 || tag!.length !== 16) throw new Error("Invalid envelope.");
      const cipher = createDecipheriv("aes-256-gcm", key, nonce!);
      cipher.setAAD(Buffer.from(JSON.stringify(["dispatch-mcp:v1", ...context, purpose])));
      cipher.setAuthTag(tag!);
      return Buffer.concat([cipher.update(ciphertext!), cipher.final()]);
    };
    const dataKey = unseal(envelope.key, root, "key");
    try { return unseal(envelope.value, dataKey, "value").toString("utf8"); }
    finally { dataKey.fill(0); }
  } catch { throw new Error("Cannot decrypt MCP state; check matching key, installation and record binding."); }
}
