# Pinned agent-browser skills

Source: https://github.com/vercel-labs/agent-browser, npm `agent-browser@0.38.2`.
License: Apache-2.0; the package LICENSE is retained verbatim. No NOTICE file was present in the installed package.

`upstream.ts` preserves the selected UTF-8 source texts verbatim as JSON-escaped line arrays joined with a newline (including the final newline). `index.ts` composes these with explicitly labeled Dispatch guidance. No runtime filesystem assets, dynamic downloads, CLI installation, or extra executor are needed to load these text skills.

Core includes its trust-boundary reference. Dogfood includes its issue taxonomy and report template. Other optional references/templates are not bundled; the Dispatch preface explains that their upstream relative paths do not resolve in this text-only loader. Unsafe upstream examples are retained for provenance, explicitly overridden by the Dispatch preface.

Updates require reviewing upstream text and Dispatch overrides together, checking both assembled instructions remain below 50,000 JavaScript characters, and reviewing the normal seed-once/revision assignment contract. Do not silently refresh instructions from the installed CLI. To re-encode a file, JSON-encode each element of `text.split("\n")` into a TypeScript array and append `.join("\n")`.

## Source SHA-256

- `skill-data/core/SKILL.md`: `9c02e42ab9bb80b78a28c7f2eba422b6f4f7aa34b37c5fba9473208ab1ec718b`
- `skill-data/core/references/trust-boundaries.md`: `011b72f87af0002beb8475b9c50baf70067737e89ca9f09ff6ce2b03a456b33c`
- `skill-data/dogfood/SKILL.md`: `83afc0f6ce5598ae56ab06c7e18090d6769ec0a9a2abb3a12df240a81c77ed02`
- `skill-data/dogfood/references/issue-taxonomy.md`: `dee7e925f7fe001903de6cc14f9656bcda90d069bbf65a2273f22202efebba09`
- `skill-data/dogfood/templates/dogfood-report-template.md`: `55eef9286e32e595dcfca30db76352e9f1d149a78b60b54644eb701072364f35`
- `LICENSE`: `014bb31e83d5c2e76aea1cc6e82217346ab41362f32cb355ad0f5c10aa0aeaff`

Package lock provenance:

```text
https://registry.npmjs.org/agent-browser/-/agent-browser-0.38.2.tgz
sha512-b/7hvo2RrqocvybjB9kwpX12kGkxkFvtdJ4XPDoott5TLK2n3aPX+lYg7ALd+2YvPi2LrTKGzQYu/rxZC2Y7ZA==
```
