import { build } from "esbuild";
import { build as viteBuild } from "vite";
import { mkdir, rm } from "node:fs/promises";
import { writeNotices } from "./notices";

await mkdir("dist", { recursive: true });
await rm("dist/reader.cjs", { force: true });
const reader = await build({
  entryPoints: ["src/main/reader-helper.ts"],
  outfile: "dist/reader.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22.13",
  minify: true,
  metafile: true,
});
const main = await build({
  entryPoints: ["src/main/main.ts"],
  outfile: "dist/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron", "pg-native"],
  metafile: true,
});
const service = await build({
  entryPoints: ["src/main/service.ts"],
  outfile: "dist/service.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["pg-native"],
  metafile: true,
});
const preload = await build({
  entryPoints: ["src/main/preload.ts"],
  outfile: "dist/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["electron"],
  metafile: true,
});
await viteBuild();
await writeNotices([
  reader.metafile!,
  main.metafile!,
  service.metafile!,
  preload.metafile!,
]);
