import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Runtime } from "@dispatch/backend";

/** Host definition artwork and trusted overrides only; never a browser-supplied path. */
export async function loadAvatars(runtime: Runtime, path = process.env.DISPATCH_AVATARS) {
  const images = new Map<string, { bytes: Buffer; mime: string }>();
  for (const avatar of await runtime.avatars?.() ?? [])
    images.set(`agent:${avatar.id}`, { bytes: Buffer.from(avatar.dataBase64, "base64"), mime: avatar.mimeType });
  if (!path) return images;
  if (!isAbsolute(path)) throw new Error("DISPATCH_AVATARS must be an absolute JSON manifest path.");
  const value = JSON.parse(await readFile(path, "utf8")) as { agents?: Record<string, string>; user?: string };
  const entries = Object.entries(value.agents ?? {}).map(([id, path]) => [`agent:${id}`, path]);
  if (value.user) entries.push(["user", value.user]);
  for (const [id, file] of entries) {
    if (typeof file !== "string" || !isAbsolute(file)) throw new Error("Avatar bindings require absolute approved file paths.");
    const bytes = await readFile(file);
    const mime = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? "image/png"
      : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? "image/jpeg"
      : bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" ? "image/webp" : undefined;
    if (!mime) throw new Error("Avatar artwork must be PNG, JPEG or WebP.");
    images.set(id, { bytes, mime });
  }
  return images;
}
