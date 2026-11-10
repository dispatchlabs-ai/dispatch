import type { IncomingMessage, ServerResponse } from "node:http";
import { passwordVerifier } from "./password-verifier.js";

const verify = await passwordVerifier(process.env.DISPATCH_BASIC_AUTH_FILE);
export async function authorize(request: IncomingMessage, response: ServerResponse) {
  const header = request.headers.authorization;
  if (header?.startsWith("Basic ") && header.length <= 1024) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator >= 0 && await verify(decoded.slice(0, separator), decoded.slice(separator + 1)))
      return true;
  }
  response.writeHead(401, {
    "www-authenticate": 'Basic realm="Dispatch", charset="UTF-8"',
    "content-type": "application/json",
  }).end(JSON.stringify({ error: "Sign in to continue." }));
  return false;
}
