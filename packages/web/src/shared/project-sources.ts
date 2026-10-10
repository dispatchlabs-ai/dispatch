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

export const projectRepositoriesSchema = z.array(z.object({
  id: repositoryId, name: z.string().trim().min(1).max(100), url: repositoryUrl,
}).strict()).refine(values => new Set(values.map(value => value.id)).size === values.length, "Repository IDs must be unique.");

export const projectSpecSchema = z.object({
  repositoryId,
  path: z.string().trim().min(1).max(4096).refine(value =>
    !/[\\:\u0000-\u001f\u007f]/.test(value) && value.split("/").every(segment => !!segment && segment !== "." && segment !== ".."),
  "Use a repo-relative file path without traversal or empty segments."),
}).strict();

export const projectSourcesSchema = z.object({
  repositories: projectRepositoriesSchema.optional(), spec: projectSpecSchema.nullable().optional(),
}).strict();
