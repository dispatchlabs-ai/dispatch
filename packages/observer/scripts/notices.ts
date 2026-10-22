import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Metafile } from "esbuild";

export async function writeNotices(builds: Metafile[]) {
  const packages = new Set<string>();
  for (const build of builds) {
    for (const input of Object.keys(build.inputs)) {
      if (!input.includes("node_modules/")) continue;
      let directory = dirname(resolve(input));
      while (directory.includes("node_modules")) {
        try {
          const manifest = JSON.parse(
            await readFile(`${directory}/package.json`, "utf8"),
          );
          if (manifest.name) {
            packages.add(directory);
            break;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        directory = dirname(directory);
      }
    }
  }
  packages.add(
    dirname(
      fileURLToPath(
        import.meta.resolve("@fontsource-variable/inter/package.json"),
      ),
    ),
  );
  const sections = [
    "# Dispatch Observer third-party notices\n\nElectron and Chromium notices are also included in the application bundle.",
  ];
  for (const directory of [...packages].sort()) {
    const manifest = JSON.parse(
      await readFile(`${directory}/package.json`, "utf8"),
    );
    const files = (await readdir(directory)).filter((name) =>
      /^(?:licen[cs]e|copying|notice)(?:\.|$)/i.test(name),
    );
    let upstream =
      manifest.name === "@earendil-works/chord" && manifest.version === "1.3.0"
        ? await readFile("licenses/chord-1.3.0.txt", "utf8")
        : undefined;
    if (!files.length && !upstream) {
      const readme = (await readdir(directory)).find((name) =>
        /^readme(?:\.|$)/i.test(name),
      );
      if (readme)
        upstream = (await readFile(`${directory}/${readme}`, "utf8")).match(
          /(?:^|\n)#+\s+licen[cs]e\b[^\n]*\n([\s\S]*)/i,
        )?.[1];
    }
    if (!files.length && !upstream)
      throw new Error(`Missing bundled license for ${manifest.name}`);
    sections.push(
      `## ${manifest.name} ${manifest.version} (${manifest.license ?? "see below"})\n\n${upstream ?? (await Promise.all(files.map((file) => readFile(`${directory}/${file}`, "utf8")))).join("\n\n")}`,
    );
  }
  sections.push(await readFile("dist/renderer/THIRD-PARTY-NOTICES.md", "utf8"));
  await writeFile("dist/THIRD-PARTY-NOTICES.md", `${sections.join("\n\n")}\n`);
}
