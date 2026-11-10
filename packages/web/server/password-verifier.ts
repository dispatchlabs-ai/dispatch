import { readFile } from "node:fs/promises";
import { scrypt, timingSafeEqual } from "node:crypto";
import { isAbsolute } from "node:path";

export async function passwordVerifier(path: string | undefined) {
  if (!path || !isAbsolute(path))
    throw new Error("Authentication requires an absolute credential file path.");
  const credential = JSON.parse(await readFile(path, "utf8"));
  if (
    typeof credential.username !== "string" || !credential.username ||
    credential.username.includes(":") ||
    !/^[a-f0-9]{32}$/.test(credential.salt) ||
    !/^[a-f0-9]{128}$/.test(credential.hash)
  ) throw new Error("Invalid authentication credential file.");
  const expected = Buffer.from(credential.hash, "hex");
  return async (username: string, password: string) => {
    const derived = await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, Buffer.from(credential.salt, "hex"), 64,
        (error, key) => error ? reject(error) : resolve(key));
    });
    return timingSafeEqual(derived, expected) && username === credential.username;
  };
}
