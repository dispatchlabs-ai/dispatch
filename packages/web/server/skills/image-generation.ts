/*
 * Seed content for the "image-generation" skill (persisted once via saveSkill;
 * assignment is independent and explicit). General image-generation guidance,
 * with Dispatch-specific guidance only where marked.
 */
export const imageGenerationSkill = {
  name: "Image generation",
  description:
    "Generate and edit images with the generate_image tool: model conventions, generation vs. reference-bounded edit modes, prompt craft, run discipline and verification.",
  instructions: [
    `# Image generation

## Model and request conventions

- Default model: \`gpt-image-2.5-sunburst\` (prioritizes quality). Use \`gpt-image-2.5-flare\` when iteration speed matters more than final quality. Never invent model ids; pinned snapshots (e.g. \`gpt-image-2.5-sunburst-2026-09-08\`) are acceptable for reproducibility.
- Sizes: desktop \`1536x1024\`, phone/portrait \`1024x1536\`, square \`1024x1024\`.
- Always \`quality: high\` for final work; \`low\`/\`medium\` only for quick iteration. Omit \`input_fidelity\` for GPT Image 2/2.5, including Sunburst and Flare. Only request it for supported legacy edit models: \`gpt-image-1\` or \`gpt-image-1.5\` (high/low), or \`gpt-image-1-mini\` (low only).
- The API response does not name the model that ran; the tool records the requested model plus per-image generation ids in the run's metadata.

## Two modes — choose deliberately

1. **Generation (no reference images):** for net-new directions only. State that fidelity to existing material is not expected. Keep one clear goal per run.
2. **Edit (references attached):** the default whenever existing material matters. Attach the current image(s) as references, describe exactly what to keep and what to change, and use a PNG alpha mask when only part of the image should change. Match the first reference’s dimensions: transparent pixels mark the editable region, opaque pixels mark what to preserve. Prompt coordinates alone are not a mask. A mask guides the model; it does not prove pixel-exact preservation. Prefer this mode: full-frame regeneration of something that already exists is where quality is usually lost.

## Prompt craft

- For UI designs, make a brief layout/type/color plan and review it against the user’s task and existing design before generating. Remove unnecessary labels, explanatory prose and decorative structure; preserve explicit brand choices.
- Be explicit about subject, composition, style, color, and lighting; avoid contradictions ("minimal" + "rich detail" in the same sentence).
- For edits, bound the region with concrete coordinates or clear spatial language ("left two-thirds", "header strip only") and state that everything outside the region must remain unchanged.
- Say what not to render: no frames, borders, watermarks, perspective, or device mockups unless explicitly requested.
- Text in images: keep it short, specify exact strings, and expect to verify — raster wording is never authoritative.

## Run discipline

- Give every run a short \`name\`; outputs and metadata land in a unique directory per run. Never write into an earlier run's directory; follow-ups are new named runs (\`refine\`, \`phone\`, \`populated\`, \`targeted-edit\`).
- The per-run \`metadata.json\` (request, reference hashes, dimensions, generation ids) is the audit trail. Do not delete or hand-edit it.
- Cancellation and failure are ambiguous: a run may have been generated and charged even when it reports failure or abort. Verify before calling again; do not assume a retry is free.
- Reference images are read from the workspace; use relative paths.
- After a provider parameter rejection, inspect the recorded request before retrying. Correct the rejected option rather than repeating the same request. If editing remains unavailable, a standalone concept must be clearly labeled as a fallback; do not claim it preserves the screenshot.

## Verification

- Inspect the actual pixels returned by \`generate_image\` before presenting the result. If image content is unavailable in your model context, open the output through an available image-reading tool; a successful status, path or metadata is not visual verification.
- Compare the result with the brief and reference: content present, hierarchy clear, edited and preserved regions correct, nothing invented. Read the raster labels manually or with OCR and check their meaning as well as spelling.
- Correct material discrepancies with a new named run when appropriate. If you cannot inspect or correct the result, explicitly label it unverified or identify the remaining deviations. Do not present a generated image as reviewed merely because the prompt asked for accuracy.

## Dispatch UI design work (only when generating Dispatch interface images)

- Brand: Inter type; navy \`#1D3D6A\` with aqua \`#4DD5CF\` accents only; ice \`#F9FAFC\`, white \`#FFFFFF\`, main text \`#10243F\`, muted text \`#53647B\`, fine borders \`#DDE6F2\`. 8px button corners, 12px surface corners, minimal shadows, readable 14–16px text, 32px main titles.
- Flat, straight-on pixels. No gradients, ornament, presentation borders, or device mockups.
- Never invent chrome: no sidebars, tabs, rails, logos, mastheads, or footers outside the bounded region being edited. Never invent statuses, counters, previews, or unread metrics. Populated examples must be labeled illustrative with synthetic data.
- Prefer the patch-sheet approach: bound the prompt to exact interior regions of a real screenshot and check that everything outside it is preserved, rather than regenerating whole frames. When exact pixel identity is required, composite the approved edited region onto the original and verify the unchanged pixels; neither a prompt nor a mask guarantees that result.`,
  ].join("\n\n"),
};
