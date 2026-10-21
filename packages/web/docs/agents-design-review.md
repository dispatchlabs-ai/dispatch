# Agents screens — visual design review

- **Date:** October 3, 2026.
- **Reviewer:** Claude Code, independent design review requested by the maintainer through the coordinator.
- **Source:** worktree `codex/agents-design-review` at baseline `ed9fcb8`.
- **Screenshots:** the canonical checkout's ignored `.local/agents-design-review/2026-10-03/`. Each is cited below as `01`–`08`, with CSS viewports from `screenshots.json`.
- **Status:** this preserves the initial review of `ed9fcb8`. The maintainer subsequently authorized the corrections and a return to Claude for design approval; see [WP-014](handoff.md#agents-and-evaluations). The proposal labels below describe their status at the time of this review. The final approval record is appended separately.

## Verdict

The maintainer is right: the Agents screens look poor. The shell constraints are not the cause. The rail chooses the section, New agent sits where New chat does, there is no redundant tab and no extra branding, and the right column is full height. All of that is sound and visible in `01`–`03`.

The problem is that WP-013 copied the Chats *chrome* (object header, sidebar rows, archive link) but not what makes the Chats main column work. Chats has an anchored composition:

- a centred empty state or transcript in the middle;
- a framed composer pinned to the bottom;
- a right column with a confident object name.

The Agents main column has none of that. It is a 14 px title, two 14 px headings, and a paragraph, floating at the top of an otherwise empty white pane. On the 1700 px capture its left edge doesn't even line up with the header. The editor is a stack of identical full-width fields, with placeholders that look like entered values and two competing exits. The result reads as an unstyled form or a debug page, not as a product surface.

Below: three real bugs, the design problems in priority order, then one cohesive proposal that keeps every agreed constraint.

## Actual bugs (fix regardless of redesign)

### B1 — The body doesn't line up with the header on wide screens

- **Evidence:** `01` (1700 px). The header title "Dispatch" starts at about x=400 px, but "About" and "Instructions" start at about x=563 px. At 1440 px (`02`) the offset shrinks to about 9 px (x=340 vs x=349), so it looks like a near-miss rather than a choice.
- **Cause:**
  - `.view-heading` is full width with `padding: var(--space-5) var(--space-8)` (`styles.css:311`).
  - `.agent-content` is `max-width: 820px; margin: 0 auto` with its own padding (`styles.css:397`).
  - The heading and body therefore use different left edges, and the body re-centres as the main column grows.
- **Fix:** give both the same left edge. Either left-align `.agent-content` (`margin: 0`) with the header's horizontal padding, or put header and body inside one shared width container. Don't centre the body under a left-aligned header.

### B2 — The agent name in the right column renders as muted empty-state text

- **Evidence:** `01`/`02`. The right column's "Dispatch" heading is grey. In `08` (Chats), the same heading in the same position is dark foreground. The rows below (Status, Model…) are also muted.
- **Cause:** `AgentDetails` wraps populated content in `className="context-empty"` (`agents.tsx:78`), so it inherits `.context-empty .context-body { color: var(--color-muted) }` (`styles.css:517`). That empty-state rule was meant for placeholder text only.
- **Fix:** use a populated details class for real content, or limit the muted rule to the empty message.

### B3 — Placeholders look like entered values

- **Evidence:** `03`, `04`. "Research partner", "What this agent does", and "You are…" read as pre-filled text. In `03` the caret sits in front of "Research partner", which makes it look like an existing value being edited.
- **Cause:** placeholders use `--color-muted` (`#53647b`, about 6:1) with `opacity: 1` (`styles.css:115, 498`). That is nearly the weight of real input text in `--color-foreground`.
- **Fix:** keep placeholders legible but unmistakably examples. Prefix them ("e.g. Research partner"), and/or use a lighter placeholder token that still meets 4.5:1 against white, such as about `#6b7a90`, checked against the token set. For Instructions, use a short example sentence rather than "You are…".

### Needs recapture, not yet a bug — `05` appears clipped horizontally

`05` (390 px) clips at the right edge: "Help your teammates know when to use this a…", the select borders, and "No to…". The text is also about 15 % larger than in `04`, the left padding differs (about 24 vs 20 px), and the bottom Menu/Details bar is missing. That pattern looks like a zoomed or panned capture (for example, focus zoom or pinch), not the resting layout. The CSS gives a single-column form with 20 px padding at this width (`styles.css:469, 482`). Please recapture `05` at rest before treating it as an overflow bug. If it reproduces unzoomed, it violates the spec's "avoid page-wide horizontal scrolling" rule.

## Design problems, in priority order

### D1 — No visual hierarchy in the main column

- Everything in `01`/`02`/`06` is the same size and weight:
  - the object title is 14 px semibold (`.view-heading h1`, `styles.css:312`);
  - the section headings are 14 px semibold (`.agent-content h2`, `styles.css:399`);
  - the body is 14 px (`styles.css:400`).
- The only differences are 600 vs 400 weight and grey vs dark text. The eye has nowhere to land.
- The accepted spec requires the *compact object header* to match Chats (spec, "Consistent collection screens"). That is correct, and it means the hierarchy must come from the **body**, not from enlarging the header. Today the body gives none.

### D2 — The composition is unanchored: three short blocks floating in a mostly empty pane

- In `01`, content ends at about y=380 of 1550. In `02` it ends at about y=320 of 860.
- Chats uses the same column with a centred empty state and a bottom-anchored composer (`08`), so the space feels intentional.
- On Agents there is no container, surface, or bottom anchor. Unstructured whitespace under unstyled text reads as "unfinished", not "calm".

### D3 — Primary action hierarchy is inverted

- **New agent** in the sidebar is a filled navy primary button. **Start chat**, the main reason to visit an agent, is a secondary outline button in the corner (`agents.tsx:37`; `01`, `02`, `06`).
- For non-default agents, the header holds a ghost **Edit** next to the secondary **Start chat**, so there is no primary action on the page at all (`agents.tsx:36–37`).
- On the phone (`06`), Start chat is a small outline chip under the title.

### D4 — The editor is an undifferentiated stack with two exits

`03`/`04`/`05` show seven blocks at identical rhythm (`.stack` gap 20 px, `styles.css:119`): Name, Description and hint, Model plus Thinking, Instructions and hint, an orphan "This version supports conversation only…" note, then buttons. Problems:

- **Instructions** is the field that defines an agent, but it gets the same visual weight as Description, sits below the model controls, and has its hint under a 220 px box where it is read after typing.
- **Two exits.** The top-right "← Back" (`agents.tsx:158`) and the bottom **Cancel** do the same thing. A back arrow at the *right* edge is also directionally odd.
- **Actions scroll off-screen.** On the phone, Create/Cancel are below the fold (`04`), with nothing pinned. Chats, by contrast, pins its composer to the bottom (`08`).
- **Native select chrome.** Large black system chevrons (`03`) look heavier than every other control, because there is no `appearance` styling on `select`.
- **Weak right column.** "This agent hasn't been saved yet." (`03`) wastes the full-height column at the moment it could help most.

### D5 — Editing locks the sidebar, and it looks broken

- **Evidence:** `03`. The New agent button is washed out (disabled), every row is disabled, and a note at the bottom ("Save or cancel your edit to choose another agent.") sits far from the cause.
- **Source:** `agent-sidebar.tsx:24, 30, 35–36, 41`.
- Disabling navigation to protect a draft is heavier than the pattern the app already uses elsewhere: confirm before discarding (`agents.tsx:309–323`, and the dirty-tab confirmation). It also looks like an error state.

### D6 — Phone layouts hide the essentials and leave the page empty

- `06`: model, provider, and thinking are visible only behind the bottom **Details** button. The main view has about 400 px of blank space below the content.
- `07`: Sign out floats directly under the archive link, mid-drawer, instead of being anchored and separated. This is shared with Chats.
- `04`/`05`: no sticky actions (see D4).

### D7 — Continuity is only partial

What matches Chats today:

- sidebar placement, search, row and selection styling, the archive link, and the compact header (`02` vs `08`). Good.

What doesn't:

- **Right-column title colour** differs (B2).
- **Right-column header:** "Agent details" is a plain 12 px label, while Chats shows a tab row (acceptable, but the details body below it is weaker).
- **Overall weight:** the Chats main column has a centred visual anchor and a framed composer; Agents has neither.
- **Rail layout toggles:** the two layout toggles (`PanelLeft`/`PanelRight`, `workspace.tsx:331–335`) sit in the rail with the same weight as section icons (`01`, `02`, `08`). That blurs "the rail chooses the section". This affects both sections and is a minor note.

## Proposed redesign (proposed, not approved or implemented)

The goal is to keep every agreed constraint and give the Agents main column the same kind of anchoring Chats has: a structured object page on top and a pinned action area at the bottom. All values use existing tokens.

### Layout sketch — agent view (desktop)

```text
┌rail┐┌ sidebar (unchanged) ┐┌──────────── main ───────────────────────────┐┌ details ─────────┐
│    ││ [+ New agent]       ││ Dispatch                         [Start chat]││ Agent details    │
│ 💬 ││ [🔍 Find an agent ] ││ Default agent · Shared with your company     │├──────────────────┤
│ 🤖 ││ AGENTS            1 │├──────────────────────────────────────────────┤│ Dispatch  Rev 1  │
│    ││ ▌Dispatch      Def. ││  General-purpose conversation assistant.     ││ Status    Active │
│    ││                     ││  (lead text, 16px, foreground)               ││ Model  gpt-6-a…  │
│    ││                     ││                                              ││ Provider  …      │
│    ││                     ││  ┌ INSTRUCTIONS ───────────────────────────┐ ││ Thinking  Low    │
│    ││                     ││  │ You are Dispatch, a thoughtful …        │ ││ Tools     None   │
│    ││                     ││  │ (15px/1.7, max 68ch, raised surface)    │ ││                  │
│    ││                     ││  └─────────────────────────────────────────┘ ││                  │
│    ││                     ││  Your operator manages this agent.           ││                  │
│    ││ Archived agents     ││                                              ││                  │
└────┘└─────────────────────┘└──────────────────────────────────────────────┘└──────────────────┘
```

### Agent view (main column)

1. **Header:** unchanged compact object header (accepted). Make **Start chat** `variant="primary"` and keep it top-right. Edit stays ghost, to its left.
2. **One left edge.** Fixes B1. Body padding is `var(--space-6) var(--space-8)`, the same as the header's horizontal padding, and the body is left-aligned. Limit the measure with `max-width: 72ch` on text blocks, not by centring the container.
3. **Lead description.** Show the description as lead text at `--text-md` (16 px), foreground colour, line-height 1.6, `margin-bottom: var(--space-8)`. Drop the "About" heading; the description *is* the about.
4. **Instructions panel.** Put the text in a raised surface: `background: var(--color-surface-raised)`, `border: 1px solid var(--color-border)`, `border-radius: var(--radius-md)`, `padding: var(--space-5) var(--space-6)`. Label it at the top with the existing small-caps style used by the sidebar "AGENTS" heading (12 px, 600, `letter-spacing: .08em`, muted). Body text 15 px (`.9375rem`; add a token if you prefer) with line-height 1.7 and `white-space: pre-wrap`. This gives the page one clear object and visual weight.
5. **Provenance note.** "Your operator manages this agent." as 12 px muted text, `margin-top: var(--space-4)`, directly under the panel.
6. **Anchoring.** Accept the remaining whitespace once the content has structure. Don't add filler. *Optional, needs a product decision:* a bottom-pinned "Start a chat with Dispatch" prompt that mirrors the Chats composer would anchor the page and shorten the path to work. It is a new behaviour, so it is not part of this proposal's baseline.

### Editor

```text
┌ main ──────────────────────────────────────────────┐┌ details ────────────────┐
│ New agent                                          ││ Draft preview  Unsaved  │
│ Shared with your company                           │├─────────────────────────┤
├────────────────────────────────────────────────────┤│ Research partner        │
│ Name            [e.g. Research partner          ]  ││ Model   GPT-6 Astra     │
│ Description     [e.g. Finds and summarizes …    ]  ││ Thinking Low            │
│                                                    ││ Tools   None            │
│ INSTRUCTIONS                                       ││                         │
│ How should this agent approach the work?           ││                         │
│ ┌────────────────────────────────────────────────┐ ││                         │
│ │ (min-height 280px, 15px/1.7)                   │ ││                         │
│ └────────────────────────────────────────────────┘ ││                         │
│ MODEL                                              ││                         │
│ [GPT-6 Astra · openai-codex ▾]  [Thinking: Low ▾]  ││                         │
├────────────────────────────────────────────────────┤│                         │
│ Conversation only; no tools.  [Cancel] [Create agent]│                         │
└────────────────────────────────────────────────────┘└─────────────────────────┘
```

1. **Remove the header "Back" button.** Cancel in the action bar is the single exit, and it keeps the existing discard confirmation.
2. **Group into three labelled sections:** Identity (Name, Description), Instructions, Model. Space fields within a section 20 px apart (`--space-5`) and sections 40 px apart (`--space-10`). Section labels use the same small-caps style as the Instructions panel label.
3. **Put Instructions first in weight.** Place it before the model settings, with a one-line prompt *above* the box ("How should this agent approach the work?") instead of a hint below it, and a textarea `min-height: 280px` at 15 px / 1.7.
4. **Pin an action bar** to the bottom of the main column, the way Chats pins its composer:
   - top border `--color-border`, background `--color-surface`, padding `var(--space-4) var(--space-8)`;
   - actions right-aligned (**Cancel** secondary, then **Create agent** / **Save new revision** primary);
   - the "Conversation only; no tools." note muted at the left;
   - on the phone the bar sits above the Menu/Details bar, with full-width buttons.
5. **Select styling:** `appearance: none` plus a muted 16 px chevron background image at `right var(--space-3) center`, so selects look like the inputs.
6. **Placeholders:** fix as in B3.
7. **Right column during editing:** show a live **Draft preview** (name, model, thinking, tools) with an "Unsaved" badge for new drafts. For edits, keep "Saved configuration" but list changed fields as "Saved → Draft". This uses the column instead of a one-line placeholder. The accepted rule to "clearly distinguish saved configuration during editing" still holds.

### Sidebar during editing

Proposed behaviour change; it needs approval because it changes how the existing WP-013 guard works.

- Keep New agent and the rows **enabled**.
- Choosing another row or New agent while the draft is dirty opens the existing discard confirmation.
- Drop the bottom "Save or cancel…" note. Show the in-progress draft row with an "Unsaved" dot rather than a disabled sidebar.

### Phone

- **Agent view:**
  - **Start chat** full-width primary under the compact header;
  - then a one-line facts summary ("GPT-6 Astra · Low thinking · No tools", 12 px muted) so the essentials are visible without opening Details;
  - then the lead description and the Instructions panel.
- **Editor:** the same sections in one column, with the pinned action bar above the bottom navigation bar.
- **Navigation drawer:** anchor **Sign out** to the bottom of the drawer with `margin-top: auto` and a top border. This applies to Chats too.

### Small continuity touches

- Fix B2 so the right-column object name matches Chats.
- Show a small "Default" tag on the default agent's sidebar row, in the same style as the right-column revision badge, so the default agent is visible without selecting it. The sidebar currently exposes that only to screen readers (`agent-sidebar.tsx:32`).
- Optional: move the two layout toggles out of the section-navigation group in the rail, or separate them with a divider and lighter weight. This applies to both sections.

## Strongest recommended direction

Keep the shell exactly as agreed, and give the Agents main column the same two anchors that make Chats look finished:

- **a structured object body** on top: lead description plus an Instructions panel on one left edge;
- **a pinned action area** at the bottom while editing.

Promote **Start chat** to the page's primary action. Fix the three bugs first, because they account for much of the "looks bad" impression on their own.

## Proposed implementation sequence

1. **Bugs.** B1 (one left edge), B2 (populated-details class), B3 (placeholders). Recapture `05` at rest.
2. **Agent view.** Primary Start chat, lead description, Instructions panel, 72ch measure, phone facts line, full-width phone Start chat.
3. **Editor.** Remove Back, add sections and order, the Instructions prompt and height, the pinned action bar, and select styling.
4. **Right column during editing.** Live draft preview, and saved-vs-draft diff for edits.
5. **Sidebar editing behaviour** (needs approval): enabled navigation with discard confirmation, and an "Unsaved" marker.
6. **Shared polish.** Default tag, drawer Sign out anchoring, optional rail toggle grouping.
7. **Re-review** rendered desktop (1440 and 1700) and 390 px phone captures, including the editor scrolled to its actions. Record keyboard, touch, and discard flows as unverified under the zero-tests policy.

## Limitations

- This review is based on eight still captures plus source reading.
- It doesn't verify hover/focus row actions (no non-default agent was captured), the archived view, keyboard order, touch behaviour, the conflict/error states, or the edit-existing-agent editor.
- `05` may be a zoomed capture (see above).
