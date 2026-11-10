import { readFile } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Only explicitly approved consumer files can be served; never a browser path. */
export async function loadAvatars(path = process.env.DISPATCH_AVATARS) {
  const images = new Map<string, { bytes: Buffer; mime: string }>();
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
