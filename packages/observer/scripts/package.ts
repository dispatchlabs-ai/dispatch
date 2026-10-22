import { packager } from "@electron/packager";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const manifest = JSON.parse(await readFile("package.json", "utf8"));
const stage = resolve(".local/package");
await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp("dist", `${stage}/dist`, { recursive: true });
await cp("LICENSE", `${stage}/LICENSE`);
await writeFile(
  `${stage}/package.json`,
  JSON.stringify({
    name: "dispatch-observer",
    productName: "Dispatch Observer",
    version: manifest.version,
    main: "dist/main.cjs",
    license: "MIT",
  }),
);
try {
  const paths = await packager({
    dir: stage,
    name: "Dispatch Observer",
    appBundleId: "ai.dispatchlabs.observer",
    appCategoryType: "public.app-category.developer-tools",
    out: resolve("out"),
    overwrite: true,
    asar: true,
    electronVersion: manifest.devDependencies.electron,
    icon:
      process.platform === "darwin"
        ? resolve("assets/icon.icns")
        : process.platform === "linux"
          ? resolve("assets/icon.png")
          : undefined,
    prune: false,
  });
  for (const path of paths) console.log(path);
} finally {
  await rm(stage, { recursive: true, force: true });
}
