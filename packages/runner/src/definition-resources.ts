import { createHash } from "node:crypto";
import { open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "typebox";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";

/** The host supplies the retained definition root, never a model-selected host path. */
export async function definitionResourcesExtension(root: string) {
  const base = await realpath(root);
  const contained = (path: string) => {
    const key = relative(base, path);
    if (key === ".." || key.startsWith(`..${sep}`) || isAbsolute(key))
      throw new Error("Definition resources must remain inside the pinned definition package.");
    return key.split(sep).join("/") || ".";
  };
  return defineExtension({
    name: "dispatch.definition-resources",
    sections: [{ key: "definition-resources", render: () =>
      "Packaged agent instructions and their linked reference files are available through read_definition_resource. " +
      "Use definition-root-relative paths such as factory.yaml, docs/repository-assignment.md, or agents/development/operations.md; omit path to list the package root. " +
      "Resolve a relative link against the packaged document's directory, then use its resulting definition-root-relative path. " +
      "These are read-only resources from this run's pinned application release. Native file and shell tools access the assigned workspace; use them for target project files. " +
      "Continue using read_skill for a skill and its own supporting resources." }],
    tools: [defineTool({
      name: "read_definition_resource",
      description: "Read a UTF-8 text file or list a directory in this run's pinned definition package. Paths are relative to the package root; omit path to list that root. This cannot read outside the package or change files.",
      parameters: Type.Object({ path: Type.Optional(Type.String()) }),
      replay: "safe",
      async execute({ path = "." }) {
        if (isAbsolute(path) || path.includes("\0")) throw new Error("Use a definition-root-relative resource path.");
        const requested = resolve(base, path);
        contained(requested);
        let canonical: string;
        try { canonical = await realpath(requested); }
        catch (error) {
          if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
            throw new Error(`Unknown definition resource: ${path}`);
          throw error;
        }
        const key = contained(canonical);
        const info = await stat(canonical);
        if (info.isDirectory()) {
          const entries = (await readdir(canonical, { withFileTypes: true }))
            .map(entry => ({ name: entry.name, kind: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "link" }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return { output: [{ type: "text", text: JSON.stringify({ path: key, entries }) }] };
        }
        if (!info.isFile()) throw new Error("Definition resources must be ordinary text files or directories.");
        const file = await open(canonical, "r");
        try {
          if (!(await file.stat()).isFile()) throw new Error("Definition resources must be ordinary text files or directories.");
          const bytes = await file.readFile();
          const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
          if (text.includes("\0")) throw new Error("Definition resources must be UTF-8 text.");
          return { output: [{ type: "text", text: JSON.stringify({ path: key,
            sha256: createHash("sha256").update(bytes).digest("hex"), text }) }] };
        } finally { await file.close(); }
      },
    })],
  });
}
