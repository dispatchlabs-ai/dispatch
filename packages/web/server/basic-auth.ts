import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { scrypt, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

// Consumer-owned credentials stay on the application host, not the TLS proxy.
const path = process.env.DISPATCH_BASIC_AUTH_FILE;
if (!path || !isAbsolute(path))
  throw new Error("DISPATCH_BASIC_AUTH_FILE must be an absolute credential file path.");
const credential = JSON.parse(await readFile(path, "utf8"));
if (
  typeof credential.username !== "string" ||
  !credential.username || credential.username.includes(":") ||
  !/^[a-f0-9]{32}$/.test(credential.salt) ||
  !/^[a-f0-9]{128}$/.test(credential.hash)
) throw new Error("Invalid Basic authentication credential file.");
const expected = Buffer.from(credential.hash, "hex");

export async function authorize(request: IncomingMessage, response: ServerResponse) {
  const header = request.headers.authorization;
  if (header?.startsWith("Basic ") && header.length <= 1024) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator >= 0 && decoded.slice(0, separator) === credential.username) {
      const derived = await new Promise<Buffer>((resolve, reject) => {
        scrypt(decoded.slice(separator + 1), Buffer.from(credential.salt, "hex"), 64,
          (error, key) => error ? reject(error) : resolve(key));
      });
      if (timingSafeEqual(derived, expected)) return true;
    }
  }
  response.writeHead(401, {
    "www-authenticate": 'Basic realm="Dispatch", charset="UTF-8"',
    "content-type": "application/json",
  }).end(JSON.stringify({ error: "Sign in to continue." }));
  return false;
}
