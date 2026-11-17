import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type AgentAvatar = { mimeType: "image/png" | "image/jpeg" | "image/webp"; dataBase64: string };

/** Artwork belongs beside the definition, including an application-root agent.md. */
export async function loadAgentAvatar(folder: string): Promise<AgentAvatar | undefined> {
  for (const extension of ["png", "jpg", "jpeg", "webp"]) {
    const path = join(folder, `avatar.${extension}`);
    let bytes: Buffer;
    try { bytes = await readFile(path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.warn(`Cannot load avatar ${path}: ${String(error)}`);
      continue;
    }
    const mimeType = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
    if (mimeType) return { mimeType, dataBase64: bytes.toString("base64") };
    console.warn(`Ignoring avatar ${path}: artwork must be PNG, JPEG or WebP.`);
  }
  return undefined;
}
