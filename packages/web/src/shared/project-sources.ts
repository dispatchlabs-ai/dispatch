import { z } from "zod";

const repositoryId = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/, "Invalid repository ID.");
const repositoryUrl = z.string().trim().min(1).max(4096).refine(value => {
  if (!/^https:\/\//i.test(value)) return false;
  if (/[\s\\?#\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !!url.hostname && !url.username && !url.password && url.pathname !== "/";
  } catch { return false; }
}, "Use a credential-free HTTPS repository URL without a query or fragment.");

function repositoryIdentity(value: string) {
  const url = new URL(value);
  // GitHub owner/repo names are case-insensitive; other hosts retain path case.
  if (url.hostname === "github.com") {
    url.pathname = url.pathname.toLowerCase().replace(/\/$/, "").replace(/\.git$/, "");
  }
  return url.href;
}

export const projectRepositoriesSchema = z.array(z.object({
  id: repositoryId, name: z.string().trim().min(1).max(100), url: repositoryUrl,
}).strict()).superRefine((values, ctx) => {
  const ids = new Set<string>();
  const urls = new Set<string>();
  values.forEach((value, index) => {
    if (ids.has(value.id)) ctx.addIssue({ code: "custom", path: [index, "id"], message: "Repository IDs must be unique." });
    ids.add(value.id);
    // Field parsing can report a malformed URL before this list refinement runs.
    if (!repositoryUrl.safeParse(value.url).success) return;
    const identity = repositoryIdentity(value.url);
    if (urls.has(identity)) ctx.addIssue({ code: "custom", path: [index, "url"], message: "This repository is already listed." });
    urls.add(identity);
  });
});

export const projectSpecSchema = z.object({
  repositoryId,
  path: z.string().trim().min(1).max(4096).refine(value =>
    !/[\\:\u0000-\u001f\u007f]/.test(value) && value.split("/").every(segment => !!segment && segment !== "." && segment !== ".."),
  "Use a repo-relative file path without traversal or empty segments."),
}).strict();

export const projectSourcesSchema = z.object({
  repositories: projectRepositoriesSchema.optional(), spec: projectSpecSchema.nullable().optional(),
}).strict();
