# Agents design approval — October 3, 2026

- **Reviewer:** Claude Code. This is the independent design approval requested under [WP-014](handoff.md#wp-014--agents-design-corrections-and-claude-approval).
- **Source:** worktree `codex/agents-design-fixes`. The working tree contains uncommitted changes on top of `ca0c343` (the docs, `agent-sidebar.tsx`, `agents.tsx`, `ui.tsx`, `workspace.tsx`, and `styles.css`).
- **Screenshots:** twelve fresh captures in the canonical checkout's ignored `.local/agents-design-fixes/2026-10-03/`, cited below as `01`–`12`. `screenshots.json` records each CSS viewport, `scrollWidth`, and `visualScale`.
- **Measured against:** the [initial review](agents-design-review.md) and the accepted spec text.
- **Scope:** visual design and source review only. No code changes, tests, commits, or wiki edits.

## Verdict

**Approved, with non-blocking follow-ups.** This is a real redesign, not a cosmetic pass. The screens now read as a product surface:

- the object page has a clear lead, a reading surface, and a primary action;
- the editor has structure and a pinned action area;
- the phone layout keeps the essentials visible.

Every bug and design problem from the initial review is resolved or adequately addressed. The agreed shell is intact: rail sections, New agent in the New chat position, no single-tab header, no extra branding, and a full-height right column. The remaining items below are refinements I would fix in the next pass. None of them is a reason to withhold approval.

## Initial findings — resolution check

| Initial finding | Status | Evidence |
| --- | --- | --- |
| **B1** body/header misalignment | **Resolved** | Header and body share one gutter (`--agent-gutter`, `styles.css:401, 413`). The left edge matches at 1440 px (`01`, x≈408) and 1700 px (`08`, x≈400). |
| **B2** muted name in details | **Resolved** | Populated details use `agent-details`; `context-empty` is reserved for empty states (`agents.tsx:277`). The name is dark in `01`/`08`, matching Chats `11`. |
| **B3** placeholders read as values | **Resolved by "e.g." prefixes** | Examples are now explicit ("e.g. Research partner", "e.g. Compare sources…") in `02`/`03`. The colour is unchanged (`styles.css:119`), which is acceptable because the prefix carries the distinction. |
| **`05` clipping** (unverified at the time) | **Not reproduced** | All phone captures report `scrollWidth` 390 and `visualScale` 1. The fields and actions fit in `03`/`04`. |
| **D1** flat hierarchy | **Resolved** | The compact header is kept (accepted). The description is lead text, and the instructions sit in a bordered, labelled reading surface at a larger size (`01`, `06`, `08`). |
| **D2** unanchored composition | **Resolved** | The page now has one object: header, then lead, then panel, then provenance note. The remaining whitespace below reads as calm rather than unfinished. |
| **D3** inverted action hierarchy | **Resolved** | **Start chat** is the filled primary action on desktop (`01`) and full width on the phone (`06`). |
| **D4** undifferentiated editor, two exits | **Resolved** | Identity, Instructions, and Model are labelled sections with 40 px gaps between sections (`styles.css:414–416`). Instructions guidance sits above the field. Back is removed. Cancel and Create sit in a pinned action bar (`02`, `09`, `12`, `03`, `04`). The shared `Select` uses a restrained chevron (`ui.tsx`; `12`). |
| **D4** idle right column | **Resolved** | A live "Draft preview" shows an Unsaved badge and updates as you type ("Untitled agent" in `02` becomes "Research partner" in `09`). |
| **D5** locked sidebar | **Resolved** | Rows stay enabled while editing and are disabled only during save (`agent-sidebar.tsx:42, 74, 95, 102`). Dirty drafts use the workspace discard confirmation (`workspace.tsx` `requestAgentAction`; `10`). The draft row shows "Unsaved" (`02`, `09`). |
| **D6** phone essentials and drawer | **Resolved** | A facts line ("GPT-6 Astra · Low thinking · No tools") sits outside Details (`06`). The drawer anchors archive and **Sign out** to the bottom (`07`). |
| **D7** continuity details | **Mostly resolved** | The Default tag shows in the sidebar (`01`). The rail layout toggles are separated by a divider (`styles.css:209`; `01`). Two small divergences remain (N2, N3). |

## Non-blocking follow-ups (recommended, not yet approved for implementation)

### N1 — On wide screens the editor's actions drift away from the form

- **Evidence:** `09` (1700 px). The form is capped at 760 px (`.agent-form-sections`, `styles.css:414`) and ends at about x=1100 CSS px. The pinned action bar spans the whole main column (`styles.css:418–419`), so **Cancel / Create agent** sit about 270 CSS px to the right of the form's edge. At 1440 px (`02`) the offset is small (about 15 px). It grows with width.
- **Suggestion:** constrain the action bar's inner row to the same 760 px measure and gutter as the form. The buttons then end on the form's right edge, and the "Conversation only · No tools" note stays aligned with the fields.

### N2 — The Agents header has a divider that the Chats header lacks

- **Evidence:** `.agent-heading` adds `border-bottom` (`styles.css:401`). A rule appears under the Agents header in `01`/`08`/`02`, but not under the Chats header in `11`.
- **Why it matters:** the accepted rule is a *shared* compact object header. The divider genuinely helps the Agents editor, where content scrolls under the header (`12`). The better fix is probably to give Chats the same divider rather than remove it from Agents.

### N3 — Model naming differs between sections

- **Evidence:** the Agents details show the display name "GPT-6 Astra" (`01`, `02`, `06`). The Chats Agent tab shows the raw ID "gpt-6-astra" (`11`).
- **Suggestion:** use the display name in both, and keep the raw ID only where it is technically needed.

### N4 — The phone editor's fixed chrome is tall (unverified risk)

- **Evidence:** in `03`/`04`, the pinned action bar, the Menu/Details bar, and the status bar together take about 200 of 843 CSS px.
- **Risk:** with the virtual keyboard open, the visible Instructions area may become very small. This is not verifiable from stills.
- **Suggestion:** hide the Menu/Details bar while an editor field has focus, or fold Cancel/Create into a single row with it. Qualify this on a device when the zero-tests policy allows.

### N5 — The phone details drawer repeats its labels

- **Evidence:** `05` shows the title "Agent details", the subtitle "For your current view", a header row "Draft preview", then "Untitled agent · Unsaved".
- **Suggestion:** drop the generic subtitle and let the header row carry the state (Draft preview or Agent details).

## Source observations

- **Edit state ownership.** Edit state is lifted into the workspace (`AgentEditing` with `initialDraft`, `draft`, `busy`; `agents.tsx:14–46`), which is what lets drafts survive rail and layout changes and lets one confirmation guard every exit. Save disables the form fieldsets (`agents.tsx:422, 475`) and sidebar navigation. A failed save restores editing (`agents.tsx:394–408`). Conflict handling and service defaults are preserved.
- **Clicking the row being edited.** Clicking the row of the agent currently being edited goes through `requestAgentAction`, so a dirty draft asks before returning to the view. That is consistent with the rule, but the behaviour is worth confirming in use.

## Not verified

- **Not captured:**
  - the edit-existing-agent state, including the saved-versus-draft change summary in the right column (`agents.tsx:233–338`);
  - the archived-agents view;
  - hover/focus row actions on a non-default agent;
  - conflict and error notices;
  - the "Edit" header action.
- **Not exercised:**
  - keyboard order and focus return after the discard dialog;
  - touch;
  - virtual-keyboard behaviour (N4);
  - save, archive, and conflict flows.

These are limits of still captures and source reading, consistent with the zero-tests policy, not observed failures.

## Recommendation

Approve WP-014's design. Fold N1–N3 into the next small UI pass, since they are quick CSS or label changes. Keep N4 as a device-qualification item, and treat N5 as optional polish.

## Follow-up re-review — October 3, 2026

- **Scope:** this section is appended after the coordinator addressed N1–N5. The earlier verdict and findings above are preserved unchanged as review history.
- **Evidence:** the same worktree with updated uncommitted source (now also `context-panel.tsx`), plus five new captures:
  - `13-final-editor-desktop-1700`;
  - `14-final-editor-phone` and `15-final-draft-details-phone` (390 px, `scrollWidth` 390, `visualScale` 1);
  - `16-final-agent-desktop`;
  - `17-final-chats-reference` (1440 px).
- **Method:** design and source review only; this is not functional acceptance.

### Verdict

**Approved. No blocking design corrections remain.** All five follow-ups are resolved in source and, where a still image can show it, in the new captures.

### N1–N5 individually

| Item | Assessment | Evidence |
| --- | --- | --- |
| **N1** wide-screen action drift | **Resolved** | The action bar's contents share the form's 760 px measure (`.agent-editor-actions-inner`, `styles.css:418–420`). In `13` (1700 px), **Create agent** ends on the fields' right edge and the note aligns with the field gutter. |
| **N2** header divider only on Agents | **Resolved** | The divider moved to the shared `.view-heading` (`styles.css:317`). Chats now shows the same rule under its header (`17`), so the compact object header is consistent across sections. |
| **N3** model naming differs | **Resolved** | Chats looks up the catalogue display name and falls back to the raw ID (`context-panel.tsx`, `model?.name \|\| agent.model?.modelId`). `17` shows "GPT-6 Astra", matching Agents. |
| **N4** tall phone editor chrome | **Improved; residual risk stays unverified** | While editing on a phone, the action-bar note and the status-bar text are hidden (`styles.css:506–507`). Fixed chrome drops from about 200 to about 140 of 843 CSS px (`14`), and the Instructions field gains visible height. The hidden note's information ("No tools") is still in Draft preview (`15`), and the hidden status text is low value in Agents ("No live conversation selected"). The virtual-keyboard case remains a device-qualification item, as noted originally. |
| **N5** repeated drawer labels | **Resolved** | The drawer is titled by state ("Draft preview" while editing, otherwise "Agent details", `workspace.tsx:482`), and the generic subtitle and redundant header row are gone (`15`). |

### Observations, non-blocking

- `16-final-agent-desktop.png` is byte-identical to `01-agent-desktop-1440.png`, so it is not independent evidence of the final agent view. Source shows the only relevant change is moving the divider from `.agent-heading` to the shared `.view-heading`, which should not change the agent view's appearance. A fresh capture would make the record cleaner, but I don't consider it necessary for approval.
- On phones, hiding the bottom status row while editing is a reasonable trade-off. If the connection status matters later (for example, editing while a chat runs elsewhere), revisit it.

### Still not verified

This is unchanged from the list above:

- the edit-existing-agent change summary;
- the archived view;
- non-default row actions;
- conflict and error states;
- keyboard order and focus return;
- touch and the virtual keyboard;
- save and archive flows.

These remain deferred under the zero-tests policy.
