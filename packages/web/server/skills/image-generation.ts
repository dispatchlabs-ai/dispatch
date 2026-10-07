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
- Always \`quality: high\` for final work; \`low\`/\`medium\` only for quick iteration. Use \`input_fidelity: high\` whenever references are attached.
- The API response does not name the model that ran; the tool records the requested model plus per-image generation ids in the run's metadata.

## Two modes — choose deliberately

1. **Generation (no reference images):** for net-new directions only. State that fidelity to existing material is not expected. Keep one clear goal per run.
2. **Edit (references attached):** the default whenever existing material matters. Attach the current image(s) as references, describe exactly what to keep and what to change, and use a mask to bound regeneration to a region. Prefer this mode: full-frame regeneration of something that already exists is where quality is usually lost.

## Prompt craft

- Be explicit about subject, composition, style, color, and lighting; avoid contradictions ("minimal" + "rich detail" in the same sentence).
- For edits, bound the region with concrete coordinates or clear spatial language ("left two-thirds", "header strip only") and state that everything outside the region must remain unchanged.
- Say what not to render: no frames, borders, watermarks, perspective, or device mockups unless explicitly requested.
- Text in images: keep it short, specify exact strings, and expect to verify — raster wording is never authoritative.

## Run discipline

- Give every run a short \`name\`; outputs and metadata land in a unique directory per run. Never write into an earlier run's directory; follow-ups are new named runs (\`refine\`, \`phone\`, \`populated\`, \`targeted-edit\`).
- The per-run \`metadata.json\` (request, reference hashes, dimensions, generation ids) is the audit trail. Do not delete or hand-edit it.
- Cancellation and failure are ambiguous: a run may have been generated and charged even when it reports failure or abort. Verify before calling again; do not assume a retry is free.
- Reference images are read from the workspace; use relative paths.

## Verification

- Check the output against the request before presenting it: content present, regions respected, nothing invented.
- Raster text and small labels must be verified separately (OCR or manual read) before being treated as correct.

## Dispatch UI design work (only when generating Dispatch interface images)

- Brand: Inter type; navy \`#1D3D6A\` with aqua \`#4DD5CF\` accents only; ice \`#F9FAFC\`, white \`#FFFFFF\`, main text \`#10243F\`, muted text \`#53647B\`, fine borders \`#DDE6F2\`. 8px button corners, 12px surface corners, minimal shadows, readable 14–16px text, 32px main titles.
- Flat, straight-on pixels. No gradients, ornament, presentation borders, or device mockups.
- Never invent chrome: no sidebars, tabs, rails, logos, mastheads, or footers outside the bounded region being edited. Never invent statuses, counters, previews, or unread metrics. Populated examples must be labeled illustrative with synthetic data.
- Prefer the patch-sheet approach: bound the prompt to exact interior regions of a real screenshot and keep everything outside the region pixel-identical, rather than regenerating whole frames.`,
  ].join("\n\n"),
};
