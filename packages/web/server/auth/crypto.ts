import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import * as OTPAuth from "otpauth";

const SCRYPT_COST = 131_072;
const SCRYPT_MEMORY = 160 * 1024 * 1024;

export const randomToken = () => randomBytes(32).toString("base64url");
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function derivePassword(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, 64, { N: SCRYPT_COST, r: 8, p: 1, maxmem: SCRYPT_MEMORY }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derivePassword(password, salt);
  return `scrypt-v1:${salt.toString("base64url")}:${key.toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  const parts = encoded?.split(":");
  const validHash = parts?.length === 3 && parts[0] === "scrypt-v1";
  // Unknown accounts perform the same expensive operation as known accounts.
  const salt = validHash ? Buffer.from(parts[1]!, "base64url") : Buffer.alloc(16);
  const expected = validHash ? Buffer.from(parts[2]!, "base64url") : Buffer.alloc(64);
  const actual = await derivePassword(password, salt);
  return !!validHash && expected.length === actual.length && timingSafeEqual(actual, expected);
}

export function loadSecretKey(path: string, hasEncryptedState: boolean): Buffer {
  if (!existsSync(path)) {
    if (hasEncryptedState) throw new Error("The authentication encryption key is missing; restore it with the authentication database.");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomBytes(8).toString("hex")}.tmp`;
    try {
      const descriptor = openSync(temporary, "wx", 0o600);
      try {
        writeFileSync(descriptor, randomBytes(32));
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      try {
        // Publish the complete key without overwriting another initializer's key.
        linkSync(temporary, path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  const key = readFileSync(path);
  if (key.length !== 32) throw new Error("The authentication encryption key must contain exactly 32 bytes.");
  return key;
}

export function encryptSecret(secret: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("dispatch-auth:v1"));
  const encrypted = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(":");
}

export function decryptSecret(value: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = value.split(":");
  if (version !== "v1" || !iv || !tag || !ciphertext) throw new Error("Invalid encrypted authentication state.");
  const cipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
  cipher.setAAD(Buffer.from("dispatch-auth:v1"));
  cipher.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([cipher.update(Buffer.from(ciphertext, "base64url")), cipher.final()]).toString("utf8");
}

export function newTotp(email: string, issuer: string) {
  const totp = new OTPAuth.TOTP({
    issuer,
    label: email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: new OTPAuth.Secret({ size: 20 }),
  });
  return { secret: totp.secret.base32, uri: totp.toString() };
}

export function matchTotpStep(secret: string, code: string, now: number): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(secret), digits: 6, period: 30, algorithm: "SHA1" });
  const delta = totp.validate({ token: code, timestamp: now, window: 1 });
  return delta === null ? null : Math.floor(now / 30_000) + delta;
}

export function newRecoveryCodes(): string[] {
  return Array.from({ length: 10 }, () => randomBytes(16).toString("hex").match(/.{8}/g)!.join("-"));
}

export const normalizeRecoveryCode = (code: string) => code.replace(/[\s-]/g, "").toLowerCase();
