/*
 * Dispatch image generation: direct OpenAI Images API calls with injected
 * runtime auth (createImageGen(models)). Generation/editing only; evidence,
 * cancellation and workspace-containment behavior per the WP-042 review.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { Type, type Models } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";

const DEFAULT_MODEL = "gpt-image-2.5-sunburst";
const SPEED_VARIANT = "gpt-image-2.5-flare";
const PROVIDER = "openai";
const SIZES = ["1024x1024", "1536x1024", "1024x1536"] as const;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const OUTPUT_DIR = "imagegen";
const MAX_REFERENCE_IMAGES = 4;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024 * 1024;

/** Thrown only with messages this file wrote, so the catch can trust them verbatim. */
class ToolError extends Error {}

/** A run record is written before submit (status "intent") and settled after. */
type RunStatus = "intent" | "not-submitted" | "succeeded" | "failed" | "aborted";

interface RunRecord {
  purpose: string;
  name: string;
  conversationId: string;
  taskId: string;
  callId: string;
  requestedModel: string;
  request: Record<string, unknown>;
  references: { path: string; sha256: string }[];
  mask?: { path: string; sha256: string };
  endpoint: string;
  startedAt: string;
  submittedAt?: string;
  httpStatus?: number;
  requestId?: string | null;
  images: { path: string; dimensions: [number, number]; sha256: string; generationId?: string }[];
  elapsedSeconds: number;
  status: RunStatus;
  error?: string;
  outcomeNote?: string;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const slugify = (name: string) => name.replace(/[^a-zA-Z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);

/** Short, structured, non-sensitive provider error labels only (type/code enums, no message bodies). */
const safeCode = (value: unknown) =>
  typeof value === "string" && value.length <= 64 && /^[a-zA-Z0-9_.:-]+$/.test(value) ? value : undefined;

/** Structural inspection of a PNG container: signature, a well-formed IHDR first chunk, dimensions, at least one IDAT image-data chunk, and a bounded chunk walk to IEND. It does not decompress IDAT or verify CRCs — container structure and image-data presence, not pixel-level validity. */
function inspectPng(bytes: Uint8Array): { width: number; height: number } | null {
  // 8 signature + 25 IHDR + 12 IEND is the smallest structural PNG.
  if (bytes.length < 45 || !PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return null;
  if (((bytes[8] << 24) | (bytes[9] << 16) | (bytes[10] << 8) | bytes[11]) >>> 0 !== 13) return null;
  if (String.fromCharCode(...bytes.subarray(12, 16)) !== "IHDR") return null;
  const width = ((bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19]) >>> 0;
  const height = ((bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23]) >>> 0;
  if (width <= 0 || height <= 0) return null;
  let offset = 8;
  let hasImageData = false;
  while (offset + 12 <= bytes.length) {
    const length = ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || offset + 12 + length > bytes.length) return null;
    if (type === "IDAT") hasImageData = true;
    if (type === "IEND") return hasImageData ? { width, height } : null;
    offset += 12 + length;
  }
  return null;
}

function textResult(text: string, isError = false) {
  return isError ? { isError: true as const, content: [{ type: "text" as const, text }] } : { content: [{ type: "text" as const, text }] };
}

const ABORT_NOTE = "Outcome unknown: the request may have reached OpenAI and been charged before cancellation. Verify what was generated before calling again; do not assume a retry is free.";
const UNCERTAIN_NOTE = "The request was submitted, so the outcome is uncertain; it may have been generated and charged. Verify before retrying.";

/** Resolve a workspace-relative path, rejecting absolute paths, ../ escapes and escaping symlinks. */
async function resolveInsideWorkspace(workspaceRoot: string, workspace: string, pathArgument: string): Promise<string> {
  if (isAbsolute(pathArgument)) throw new ToolError(`Path must be workspace-relative: ${pathArgument}`);
  const real = await realpath(resolve(workspace, pathArgument));
  if (real !== workspaceRoot && !real.startsWith(workspaceRoot + sep))
    throw new ToolError(`Path escapes the workspace: ${pathArgument}`);
  return real;
}

/** Read a bounded, decodable workspace PNG; null when no path was given. */
async function readWorkspacePng(workspaceRoot: string, workspace: string, pathArgument: string | undefined, role: string) {
  if (!pathArgument) return null;
  const real = await resolveInsideWorkspace(workspaceRoot, workspace, pathArgument);
  const { size } = await stat(real);
  if (size > MAX_INPUT_BYTES) throw new ToolError(`${role} exceeds the ${MAX_INPUT_BYTES / (1024 * 1024)} MiB limit: ${pathArgument}`);
  const bytes = new Uint8Array(await readFile(real));
  if (!inspectPng(bytes)) throw new ToolError(`${role} is not a structurally valid PNG image: ${pathArgument}`);
  return bytes;
}

/** Read the response body with a hard byte cap, cancelling the stream and releasing the reader on every early exit. */
async function readBoundedBody(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ToolError("The provider response exceeds the size limit.");
  }
  const body = response.body;
  const reader = body?.getReader();
  if (!body || !reader) {
    await body?.cancel().catch(() => undefined);
    throw new ToolError("The provider response has no body.");
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.length;
      if (total > MAX_RESPONSE_BYTES) throw new ToolError("The provider response exceeds the size limit.");
      chunks.push(value);
    }
  } catch (error) {
    // Cancel the stream so a rejected download never keeps running...
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    // ...but cancel() does not release the lock; release it on every exit.
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength))).toString("utf8");
}

export function createImageGen(models: Models) {
  const generateImage = defineTool({
    name: "generate_image",
    description:
      `Generate or edit an image with the OpenAI Images API (default ${DEFAULT_MODEL}, ${SPEED_VARIANT} for fast iteration). With reference images (and optionally a mask PNG) this calls /v1/images/edits; otherwise /v1/images/generations. Writes PNG outputs and a per-run metadata record (request, reference hashes, dimensions, generation ids) under the workspace imagegen directory and returns the output paths plus native image content for visual inspection. Inspect the returned images before presenting them. When the image-generation skill is assigned, load it first and follow its prompt craft.`,
    parameters: Type.Object({
      prompt: Type.String({ minLength: 1, maxLength: 32_000, description: "Full image prompt, written per the assigned skill's prompt craft." }),
      name: Type.String({ minLength: 1, maxLength: 64, description: "Short slug naming this run's directory, outputs and metadata record." }),
      model: Type.Optional(Type.String({ maxLength: 64, description: `Images model id. Default ${DEFAULT_MODEL}.` })),
      size: Type.Optional(Type.Union(SIZES.map((size) => Type.Literal(size)), { description: "Output size. Default 1536x1024." })),
      quality: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high")], { description: "Default high." })),
      input_fidelity: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("high")], { description: "Legacy edit option for gpt-image-1 and gpt-image-1.5 (high/low), or gpt-image-1-mini (low). Omitted for other models, including GPT Image 2/2.5. No default is injected." })),
      n: Type.Optional(Type.Integer({ minimum: 1, maximum: 4, description: "Number of variants. Default 1." })),
      images: Type.Optional(Type.Array(Type.String(), { minItems: 1, maxItems: MAX_REFERENCE_IMAGES, description: "Reference image paths, workspace-relative. Present means an edit run." })),
      mask: Type.Optional(Type.String({ description: "Optional mask PNG path; fully transparent regions are regenerated. Requires reference images." })),
    }),
    // Network side effect with billing; an interrupted call must never re-run on recovery.
    replay: "unsafe",
    execute: async (args, api, context) => {
      const started = Date.now();
      const workspace = api.env?.cwd;
      if (!workspace)
        return textResult("generate_image requires a workspace. This participant has no workspace configured, so there is nowhere to write outputs.", true);
      if (args.mask && !args.images?.length)
        return textResult("A mask requires reference images; without them there is no image to edit.", true);

      const requestedModel = args.model ?? DEFAULT_MODEL;
      const size = args.size ?? "1536x1024";
      const quality = args.quality ?? "high";
      const count = args.n ?? 1;
      // Only the documented legacy image models accept this optional edit parameter.
      // In particular, old saved skills must not force it into GPT Image 2/2.5 requests.
      const isEditRun = (args.images?.length ?? 0) > 0;
      const supportsFidelity = /^gpt-image-1(?:\.5|-mini)?(?:-\d{4}-\d{2}-\d{2})?$/.test(requestedModel);
      if (isEditRun && supportsFidelity && requestedModel.startsWith("gpt-image-1-mini") && args.input_fidelity === "high")
        return textResult("gpt-image-1-mini accepts only input_fidelity: low. No request was made.", true);
      const request: Record<string, unknown> = { model: requestedModel, prompt: args.prompt, size, quality, n: count,
        ...(isEditRun && supportsFidelity && args.input_fidelity !== undefined ? { input_fidelity: args.input_fidelity } : {}) };
      const endpoint = isEditRun ? "https://api.openai.com/v1/images/edits" : "https://api.openai.com/v1/images/generations";

      let metadataPath: string | undefined;
      let record: RunRecord | undefined;
      let recordPersisted = false;
      // Atomic record updates: a crash mid-write never destroys the earlier evidence, though a stray .tmp file may remain.
      const persist = async () => {
        if (!record || !metadataPath) return;
        await writeFile(`${metadataPath}.tmp`, JSON.stringify(record, null, 2));
        await rename(`${metadataPath}.tmp`, metadataPath);
        recordPersisted = true;
      };
      // Report only what was actually saved; never claim evidence a failed write may not have produced.
      const auditNote = () => recordPersisted && metadataPath
        ? `The run record at ${metadataPath} retains the request for audit.`
        : "The run record may be missing or incomplete; check the run directory for what was persisted.";

      try {
        const workspaceRoot = await realpath(workspace);
        // Fixed workspace output root; a symlink planted at imagegen/ cannot move outputs outside.
        await mkdir(join(workspace, OUTPUT_DIR), { recursive: true });
        const outputRoot = await realpath(join(workspace, OUTPUT_DIR));
        if (outputRoot !== workspaceRoot && !outputRoot.startsWith(workspaceRoot + sep))
          throw new ToolError("The workspace imagegen directory resolves outside the workspace.");

        // Exclusive directory creation: a collision fails instead of reusing or overwriting.
        let runDir: string | undefined;
        let lastError: unknown;
        for (let attempt = 0; attempt < 4 && !runDir; attempt++) {
          const candidate = join(outputRoot, `${slugify(args.name)}-${api.conversationId}-${randomUUID()}`);
          try { await mkdir(candidate); runDir = candidate; }
          catch (error) { lastError = error; }
        }
        if (!runDir) throw lastError instanceof Error ? lastError : new ToolError("Could not create a unique run directory.");
        await mkdir(join(runDir, "outputs"));
        metadataPath = join(runDir, "metadata.json");
        record = {
          purpose: "Dispatch image generation; API billed cost is not returned and not estimated.",
          name: args.name,
          conversationId: String(api.conversationId),
          taskId: String(api.taskId),
          callId: api.callId,
          requestedModel,
          request,
          references: [],
          endpoint,
          startedAt: new Date().toISOString(),
          images: [],
          elapsedSeconds: 0,
          status: "intent",
        };

        const references: { path: string; bytes: Uint8Array<ArrayBuffer> }[] = [];
        for (const pathArgument of args.images ?? []) {
          const bytes = await readWorkspacePng(workspaceRoot, workspace, pathArgument, "Reference image");
          if (!bytes) continue;
          record.references.push({ path: pathArgument, sha256: sha256(bytes) });
          references.push({ path: pathArgument, bytes });
        }
        const maskBytes = await readWorkspacePng(workspaceRoot, workspace, args.mask, "Mask");
        if (args.mask && maskBytes) record.mask = { path: args.mask, sha256: sha256(maskBytes) };

        // Pre-request intent: the record exists before any network call.
        await persist();

        if (context.abortSignal?.aborted) {
          record.status = "not-submitted";
          record.outcomeNote = "Cancelled before submit; no request was made.";
          await persist();
          return textResult("Cancelled before submit. No request was made.", true);
        }

        let apiKey: string | undefined;
        try { apiKey = (await models.getAuth(PROVIDER, { signal: context.abortSignal }))?.auth.apiKey; }
        catch (error) {
          if (context.abortSignal?.aborted) throw error;
          record.status = "not-submitted";
          record.error = `credential_resolution_failed (${error instanceof Error ? error.name : "unknown"})`;
          await persist();
          return textResult(`Credential resolution failed for the ${PROVIDER} provider. No request was made.`, true);
        }
        if (!apiKey) {
          record.status = "not-submitted";
          record.error = `No API key configured for the ${PROVIDER} provider.`;
          await persist();
          return textResult(record.error, true);
        }

        const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}` };
        let body: FormData | string;
        if (references.length > 0) {
          const form = new FormData();
          for (const [key, value] of Object.entries(request)) form.append(key, String(value));
          for (const [index, reference] of references.entries())
            form.append("image[]", new Blob([reference.bytes], { type: "image/png" }), `reference-${index}.png`);
          if (args.mask && maskBytes)
            form.append("mask", new Blob([maskBytes], { type: "image/png" }), "mask.png");
          body = form;
        } else {
          headers["Content-Type"] = "application/json";
          body = JSON.stringify(request);
        }

        // Recheck cancellation immediately before submission; after this point an abort is outcome-unknown.
        if (context.abortSignal?.aborted) {
          record.status = "not-submitted";
          record.outcomeNote = "Cancelled before submit; no request was made.";
          await persist();
          return textResult("Cancelled before submit. No request was made.", true);
        }

        record.submittedAt = new Date().toISOString();
        const response = await fetch(endpoint, { method: "POST", headers, body, signal: context.abortSignal });
        record.httpStatus = response.status;
        record.requestId = response.headers.get("x-request-id");
        const bodyText = await readBoundedBody(response);

        let parsed: unknown;
        try { parsed = JSON.parse(bodyText); }
        catch { throw new ToolError("The provider response was not valid JSON."); }

        if (!response.ok) {
          const providerError = (parsed as { error?: { type?: unknown; code?: unknown; param?: unknown } }).error;
          const code = safeCode(providerError?.type) ?? safeCode(providerError?.code);
          // The rejected parameter name is a short identifier and names the exact contract violation.
          const param = safeCode(providerError?.param);
          const detail = `HTTP ${response.status}${code ? `, ${code}` : ""}${param ? `, param=${param}` : ""}`;
          record.status = "failed";
          record.error = `provider_error (${detail})`;
          await persist();
          return textResult(`Image generation failed (${detail}). ${auditNote()}`, true);
        }

        // Structured validation: every requested image must decode; partial results are failures.
        const data = (parsed as { data?: unknown }).data;
        if (!Array.isArray(data) || data.length !== count)
          throw new ToolError(`The provider returned ${Array.isArray(data) ? data.length : 0} of ${count} requested images.`);
        const decoded: { bytes: Uint8Array<ArrayBuffer>; width: number; height: number; generationId?: string }[] = [];
        for (const item of data) {
          const member = item as { b64_json?: unknown; generation_id?: unknown };
          if (typeof member?.b64_json !== "string" || !member.b64_json) throw new ToolError("The provider response was missing image data.");
          const bytes = new Uint8Array(Buffer.from(member.b64_json, "base64"));
          const png = inspectPng(bytes);
          if (!png) throw new ToolError("The provider response contained an image that is not a structurally valid PNG.");
          decoded.push({ bytes, width: png.width, height: png.height, generationId: safeCode(member.generation_id) });
        }
        // All members validated before any file is written. Atomic writes mean no partial final PNG can remain,
        // but a crash can still leave stray .tmp files or only some completed outputs — the record lists
        // only outputs actually renamed into place.
        for (const [index, image] of decoded.entries()) {
          const path = join(runDir, "outputs", `${slugify(args.name)}${index === 0 ? "" : `-${index}`}.png`);
          await writeFile(`${path}.tmp`, image.bytes);
          await rename(`${path}.tmp`, path);
          record.images.push({ path, dimensions: [image.width, image.height], sha256: sha256(image.bytes), generationId: image.generationId });
        }
        record.status = "succeeded";
        await persist();
        return {
          content: [{
            type: "text" as const,
            text: [
              `Generated ${record.images.length} image(s) via ${endpoint} (requested model ${requestedModel}).`,
              ...(args.input_fidelity !== undefined && !request.input_fidelity ? [`input_fidelity was omitted for this model/mode.`] : []),
              "Inspect the returned image content against the brief and reference before presenting it. Check text, layout and preserved regions; report discrepancies or revise as needed.",
              ...record.images.map((image) => `${image.path} ${image.dimensions[0]}x${image.dimensions[1]}${image.generationId ? ` generation_id=${image.generationId}` : ""}`),
            ].join("\n"),
          }, ...decoded.map(image => ({ type: "image" as const, mimeType: "image/png", data: Buffer.from(image.bytes).toString("base64") }))],
          details: { runDir, endpoint, requestedModel, images: record.images },
        };
      } catch (error) {
        // A cancellation caught before submittedAt is a known no-request; in-flight aborts are outcome-unknown.
        if (record && context.abortSignal?.aborted && !record.submittedAt) {
          record.status = "not-submitted";
          record.outcomeNote = "Cancelled before submit; no request was made.";
          await persist().catch(() => undefined);
          return textResult("Cancelled before submit. No request was made.", true);
        }
        if (record && context.abortSignal?.aborted) {
          record.status = "aborted";
          record.outcomeNote = ABORT_NOTE;
          await persist().catch(() => undefined);
          return textResult(`Image generation was cancelled while the request was in flight. ${ABORT_NOTE}`, true);
        }
        if (record) {
          const submitted = Boolean(record.submittedAt);
          record.status = "failed";
          record.error = error instanceof ToolError ? error.message : error instanceof Error ? error.name : "unknown";
          record.outcomeNote = submitted ? UNCERTAIN_NOTE : "The request was not submitted.";
          await persist().catch(() => undefined);
          const detail = error instanceof ToolError ? error.message : "the request failed before a response was received";
          const written = record.images.length ? ` Written before the failure: ${record.images.map((image) => image.path).join(", ")}.` : "";
          return textResult(`Image generation failed: ${detail}. ${record.outcomeNote}${written} ${auditNote()}`, true);
        }
        // Failure before the run record existed: nothing was submitted.
        return textResult(`Image generation failed before a run started: ${error instanceof Error ? error.name : "unknown"}. No request was made.`, true);
      } finally {
        if (record) {
          record.elapsedSeconds = (Date.now() - started) / 1000;
          // Best-effort final settlement; the earlier atomic record already guarantees evidence.
          await persist().catch(() => undefined);
        }
      }
    },
  });

  return defineExtension({
    name: "dispatch-image-gen",
    tools: [generateImage],
    sections: [section("image-gen", (input) => {
      if (!input.agent.tools.some((tool) => tool.name === generateImage.name)) return undefined;
      return [
        "You can generate and edit images with generate_image. When the image-generation skill is assigned, load it first and follow its prompt craft.",
        "Successful results include image pixels for inspection. Review them against the brief, including readable labels and preserved regions, before publishing; a file path or successful API response is not visual verification.",
        "Every run writes outputs plus a metadata record; treat that record as the audit trail and never regenerate into an earlier run's directory.",
        "A cancelled or failed run may still have been generated and charged: verify before calling again.",
      ].join(" ");
    })],
  });
}
