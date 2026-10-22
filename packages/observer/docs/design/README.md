# Observer visual references

These are ImageGen mockups of the intended Electron application, generated on
October 22, 2026. They are not screenshots of running software. Every connection,
agent, path, URL, event, and timestamp shown is synthetic.

| Image | Design focus | Use cases |
| --- | --- | --- |
| [01 — Live activity](01-live-activity.png) | Source rail, delegation tree, selected tool, and live-following controls | OBS-006–OBS-010 |
| [02 — Workflow playback](02-workflow-playback.png) | Workflow attempts, selected historical error, explicit recorded playback | OBS-009, OBS-011–OBS-014 |
| [03 — Add a connection](03-add-connection.png) | SQLite/Postgres source choice, tunnel fields, separate store selection | OBS-001–OBS-005 |

The [design guide](../../DESIGN_GUIDE.md) owns the intended behavior, tokens,
layout, and implementation boundaries. These images retain the original concept's
quiet light surfaces, blue selection, task hierarchy, and adjacent inspector.
They extend it with desktop source navigation and recorded-playback controls.

## Generation provenance

- Tool: built-in **ImageGen**; no CLI fallback or API key was used.
- Inputs: text prompts only, based on the prior concept's visual system. No live
  application capture, database content, company data, or reference photo was sent.
- Outputs: three opaque PNGs, each 1586×992 pixels. All three selected outputs are
  kept in this package at the paths above.
- [PROMPTS.md](PROMPTS.md) preserves the common direction and exact screen-specific
  prompt text. The tool's default model/settings were used; no model version or
  deterministic seed is asserted.
- The PNGs retain their generated-content provenance metadata. Inspect image
  pixels and metadata before replacing or publishing later versions.

## Visual review and limits

The three outputs were visually inspected for legible primary labels, consistent
layout, synthetic examples, the intended screen state, and absence of agent
execution controls. The live view shows a working child under a waiting parent;
the historical view distinguishes a failed attempt from a completed workflow;
the connection view separates source type from its transport.

Generated details are illustrative, not final component dimensions or acceptance
evidence. The guide clarifies overall-work versus selected-task status, current/
final phase versus playhead state, precise credential-storage copy, and avoiding
duplicated help text. Runtime behavior, full event ordering, keyboard navigation,
screen readers, measured contrast, dark mode, narrow windows, and Windows/Linux
appearance have not been verified by these images.

No browser/Electron screenshot, application build, installer, database access,
or transport qualification is claimed. A future implementation must be reviewed
rendered and interactively under the repository's permitted check policy.
