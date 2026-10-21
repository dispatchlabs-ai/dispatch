import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Restricted regular files only. Never repair permissions or regenerate keys. */
export async function readRestrictedConfigurationFile(filename: string, secret: boolean): Promise<Buffer> {
  const file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    const uid = process.geteuid?.();
    const permissionsValid = secret
      ? (stat.mode & 0o7777) === 0o600 && stat.uid === uid
      : (stat.mode & 0o022) === 0 && (stat.uid === 0 || stat.uid === uid);
    if (!stat.isFile() || stat.size > 1_048_576 || !permissionsValid)
      throw new Error("Configuration requires restricted operator-owned regular files.");
    return await file.readFile();
  } finally { await file.close(); }
}
