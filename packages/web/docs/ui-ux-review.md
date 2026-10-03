# Dispatch Web UI/UX review — October 3, 2026

**Reviewer:** Claude Code (independent of the implementing agents), at Chris's request.
**Revision reviewed:** `main` at `d83f70d57ccd0d592faf8a61843e20424bfd9a85`.
**Status:** review record, not a validation plan. Findings are inputs to later work packages; nothing here was fixed in application code.

The proposed rules derived from these findings are in [spec.md § UI implementation rules](spec.md#ui-implementation-rules).

## Method and limitations

- **Source review** of every browser component (`src/components/*.tsx`, `src/lib/*`, `src/root.tsx`) and `src/styles.css`, measured against the [spec](spec.md), [handoff](handoff.md), [AGENTS.md](../../../AGENTS.md), the workspace sketch, and the brand references the spec pins.
- **Contrast ratios** were computed from the stylesheet's literal colors with the WCAG relative-luminance formula. This is arithmetic on source values, not a browser test.
- **Visual inspection** covered only the unauthenticated sign-in screen, via headless Chrome screenshots at 1440×900 and 1000×800. The 390-pixel capture rendered wider than its window (a headless window-size limit), so it is **not** evidence about phone layout either way.
- **Not observed:** the authenticated workspace, chat, agents, account/security, enrollment, recovery, and every narrow-screen panel. Findings about those screens come from source only. No account, credential, or enrollment was used or changed. No tests, API smoke checks, or acceptance procedures were run, following the [testing policy](spec.md#testing-policy).
- **Wiki:** `wiki.chrisreynolds.me` needs a login, and this session has no wiki connection. Wiki use cases and decision records beyond what the spec quotes were not read.

## 1. Violations of existing accepted rules

Each item cites the accepted requirement it breaks.

| # | Evidence | Observable consequence | Requirement |
| --- | --- | --- | --- |
| V1 | `styles.css` uses 9–11 px text across product chrome: `.workspace-status` 10 px (202), 9 px on mobile (405); composer hint 9 px (301, 416); `.status-badge` 9 px (254); `.revision-badge` 9 px (216); message time 9 px (267); page eyebrow 9 px (307). Many secondary colors fail 4.5:1. Composer hint `#8d99aa` is 2.89:1, message time `#91a0b1` 2.67:1, "Working on your response" / "Response stopped" `#7e8ba0` 3.45:1, privacy note 3.17:1, sidebar empty/footer 3.42:1, archived and section-empty notes ≈3.05:1, status badge 3.96:1, chat-heading model line 3.24:1. | Run status ("Stopped", "Responding"), connection state, timestamps, and guidance are hard to read, especially on phones, where status text shrinks to 9 px. | [Branding](spec.md#dispatch-branding): "Keep text, controls, status, and focus indicators readable and distinguishable." |
| V2 | The active main tab is marked by an aqua underline (`#4dd5cf` on white, 1.79:1) and a white background against a `#fbfcfe` toolbar (1.03:1) (`styles.css:191`). The copy-message icon `#8a97a8` is 2.97:1 (274). | Which main tab is active depends mostly on a text-weight change, and the copy control falls below the 3:1 non-text minimum. | Same as V1 ("controls … distinguishable"). |
| V3 | About 80 colour literals sit outside the token block (`styles.css` lines 26–442), for example `#eaf0f8`, `#f6f8fb`, `#7b879a`, `#b08032`, and `#91a0b1`. Only seven colours are tokens (`@theme`, lines 4–13), plus three ad-hoc `:root` variables. The referenced [Dispatch token file](https://github.com/dispatchlabs-ai/dispatch-web/blob/8ab0014bdd69c1585810cdb2099c5aa390843cd2/apps/web/src/styles/dispatch-tokens.css) defines a type scale starting at 12 px (`--text-xs`), plus spacing, radius, and status tokens. The implementation ignores that scale and replaces `--dispatch-success`/`--dispatch-danger` with undocumented darker values. | Grey tints drift from screen to screen. A palette or contrast fix needs edits on dozens of lines. Undocumented status colours make brand traceability impossible. | [Branding](spec.md#dispatch-branding): "Theme shared components through common design tokens … typography and other styling defined by the brand materials." |
| V4 | The bottom bar shows "Workspace connected" whenever the active tab is not a chat (`workspace.tsx:214`: `connection || "connected"`). Nothing is observed for Welcome, Agents, or Account. | The status claims a connection that was never checked. During a service outage on the Agents tab, the bar still says "connected". | [Workspace layout](spec.md#workspace-layout): the bottom bar "shows … connection state." |
| V5 | `SecurityPage` is not kept mounted (`workspace.tsx:207` keeps only `agents` mounted). Its typed password, passkey name, and in-progress authenticator replacement (`security.tsx:17–21`) are discarded when the user switches main tabs. | A user halfway through replacing their authenticator who checks a chat must start again. | [Desktop and mobile](spec.md#desktop-and-mobile-support): "Changing … visible workspace region must preserve the active work and unsent input"; [workspace layout](spec.md#use-case-switch-work-and-its-supporting-views): "Preserve … active work when changing layouts or main tabs." |

## 2. Gaps where guidance should be sharper

These issues don't clearly break an accepted rule, but each one produced weaker UX that a sharper rule would have prevented.

**Input and state preservation**

- **G1. Session expiry and sign-out discard all workspace state.** `AuthGate` renders the workspace only while authenticated (`auth.tsx:37–38`). The session timer sets `signed_out` at expiry (`session.tsx:141–143`). Drafts, open tabs, and pending request IDs live in `Workspace` state (`workspace.tsx:27–37`), so they are lost. With a 30-minute idle timeout that SSE heartbeats don't extend (spec line 71), a user who spends 30 minutes reading and writing without sending loses the draft. There is no expiry warning. The spec protects drafts across layout and tab changes only.
- **G2. Closing a main tab with unsaved input discards it silently.** This covers the agent editor (`agents.tsx:23`, state in `AgentsPage`) and in-progress security flows. Nothing asks the user or keeps a draft.
- **G3. Transcript scroll position is lost on tab switch.** Inactive chat panels unmount (`workspace.tsx:207`), and remounting scrolls to the bottom (`chat.tsx:33,77–80`). A reader halfway up a long answer loses their place.

**Keyboard, ARIA, and touch**

- **G4. Main tab strip focus and semantics.** Each tab's close `IconButton` is rendered inside the `Tabs.List` element next to its tab (`workspace.tsx:198–200`). Every close button therefore adds a Tab stop. Whether the tab list's accessibility tree stays valid with these extra controls was not checked. WAI-ARIA 1.2 requires a `tablist` to own `tab` elements, but its normative text does not clearly settle associated close controls, and no accessibility tree was inspected. Treat it as a semantics concern to check against the WAI-ARIA Authoring Practices tabs pattern, not a proven defect. Separately, and proven from source: `activateOnFocus` (line 198) means arrowing across tabs activates each chat in turn. Each activation mounts a `ChatPanel`, opens and closes an SSE stream, and rewrites the URL.
- **G5. Rail destinations use `aria-pressed`** (`workspace.tsx:188–190`), which announces them as toggle buttons rather than as the current location (`aria-current`).
- **G6. Icon-only controls rely on `title` tooltips** (`ui.tsx:16`). Touch users never see these. On narrow screens the toolbar's primary actions are three unlabeled icons: navigation, New chat, and supporting view (`workspace.tsx:195–203`). Nothing visible says that a supporting view exists.
- **G7. Small touch targets** on primary mobile actions: tab close 28×28 (`styles.css:195, 401`), copy 27×28 (274), agent-card buttons 35 px (345), and context tab buttons sized to their text (211). These pass WCAG 2.2's 24 px minimum but sit below the 44 px used elsewhere for mobile buttons (`styles.css:355`).
- **G8. Text sizes are in `px`.** Browsers' default-font-size settings don't scale them; only page zoom does. The spec requires readability "when text is enlarged" but doesn't say which enlargement method counts.
- **G9. Weak composer focus.** The textarea removes its outline (`styles.css:299`), leaving a 1 px border colour change and a 10 % aqua glow (296).

**Hierarchy and copy**

- **G10. Page `<h1>`s are slogans, not names.** Agents: "Made for the way you work." (`agents.tsx:26`). Welcome: "Where should we begin?" (`workspace.tsx:226`). Screen-reader heading navigation and the visual hierarchy don't name the destination.
- **G11. The responding agent is labelled "Dispatch"** (`chat.tsx:159`), and the chat subtitle is a raw model ID (`chat.tsx:101`). The user picked a named agent, but neither the transcript nor the header shows its name.
- **G12. Agent name disappears after any edit.** The context panel shows the definition name only when its current revision equals the chat's revision. Otherwise it shows "Saved agent setup" (`context-panel.tsx:27`). Editing an agent therefore removes its name from every older conversation.
- **G13. Internal data leaks into the main reading surface.** It appears as raw JSON blocks ("Additional entry information", unknown entry kinds, tool arguments/details: `chat.tsx:143–146,156–163`), raw enum statuses (`tool.status`, `chat.tsx:114`), and raw `unanswered` reasons (`context-panel.tsx:38`). The spec requires keeping native distinctions; it doesn't say how to present them.

**Contextual column, states, and auth friction**

- **G14. Non-chat supporting views are static marketing-style help copy** (`context-panel.tsx:13–14`), and Welcome shows an empty full-height column with no explanation (`context-panel.tsx:15`). The spec says not to add "unrelated widgets" but doesn't say whether static guidance counts as context.
- **G15. Connection problems appear only in the 9–10 px bottom bar** (`workspace.tsx:214`), away from the chat the user is watching. The chat's own error state appears only when the snapshot fetch or parse fails (`chat.tsx:109`).
- **G16. Changing a sign-in method forces a full sign-out** (`security.tsx:46`) instead of an in-place re-check. Combined with G1, this loses all workspace state. Sign-out is also a single unconfirmed icon on the rail next to Account (`workspace.tsx:190`).
- **G17. Passkey autofill is declared but not wired up.** The email field sets `autoComplete="username webauthn"` (`auth.tsx:70`), but no conditional-mediation request is started. Browsers therefore won't offer passkeys from the email field.
- **G18. "Latest messages" is positioned at a fixed `bottom: 170px`** (`styles.css:292`). It can overlap the composer once the textarea grows to its 180 px maximum.

**Agent-development drift**

- **G19. Two styling systems, neither used fully.** Tailwind is a declared dependency imported at `styles.css:1`, but feature code uses one utility (`capitalize`). Everything else is a 442-line global stylesheet. The earlier shadcn-on-Base-UI recommendation (owned components, `cva` variants, token-only lint rules) was not adopted. That was never an accepted requirement, so it is not a violation. Without a recorded choice, though, future agents will keep mixing approaches.
- **G20. Unformatted JSX lines.** Nineteen JSX lines exceed 400 characters (e.g. `workspace.tsx:208` 990, `:221` 1,299, `:226` 1,020). This makes review and diffs, including this review, harder and hides problems such as G22. The repository has no formatter.
- **G21. One documentation claim is broader than the code.** The spec says "Keyboard focus and touch controls use shared primitives" (line 97, before this review). That holds for buttons, icon buttons, inputs, dialogs, and tabs, which use Base UI or its wrappers. It does not hold for selects, checkboxes, radios, textareas, or the conversation list buttons, which are native elements with per-screen styling (G22). The changelog's "shared Base UI controls" is accurate for the controls just listed, and its "brand acceptance checks" line describes a requirement, not a claim that checks were completed. Under the zero-tests policy, coverage claims need to say which controls they cover, and unchecked properties need to be labelled as unverified.
- **G22. No shared-control styling policy.** Native semantic `<select>`, `<textarea>`, checkbox, radio, and `<button>` elements are appropriate in themselves, and `Tabs` imported directly from `@base-ui/react/tabs` (`workspace.tsx:1`, `context-panel.tsx:1`) is still Base UI. Earlier advice to ban direct primitive imports was a recommendation, not an accepted requirement. The proven problem is inconsistency. The Welcome agent `<select>` (`workspace.tsx:226`) is styled separately (`styles.css:247`: 12 px, `--color-border`) from form selects (`.field select`, `styles.css:66`: 14 px, `#ccd7e6`). Below 600 px only `.field` controls move to 16 px (`styles.css:354`). The Welcome select therefore stays at 12 px, which on iOS Safari causes a page zoom when focused, unlike the other selects. No rule says which controls must go through `src/components/ui` wrappers or shared control styles.

## 3. Optional design preferences

These are matters of taste, not requirements.

- **Copy register.** Taglines inside the product chrome ("A little more room to think.", `workspace.tsx:221`; "Make room for what's next.") read as marketing. On the login brand panel they work; in the working sidebar they compete with content.
- **Bottom bar on phones.** It spends a 29 px row on 9 px text. Folding connection state into the toolbar on narrow screens may serve better.
- **Right column on Welcome.** Consider a short line explaining what will appear there once a conversation is open, rather than leaving a blank column.

## What works well

- The sign-in page matches the brand. The inverse logo sits on navy, the primary logo on white, Inter is served locally, the hierarchy is clear, and the passkey and password paths are distinct (desktop and 1000 px screenshots).
- Contextual-column ownership is sound. Supporting-tab selection is stored per main tab (`workspace.tsx:37,174`), snapshots are keyed by chat, and the active context derives from the active tab, which meets the "late updates for A" rule. Chat drafts and pending request IDs are lifted per chat and survive tab and layout changes.
- The focus ring (`#267e9b`, 4.63:1 on white) and the rail's aqua focus outline (6.09:1 on navy) are visible. There is a skip link and reduced-motion handling, 16 px mobile inputs prevent iOS zoom, and Enter-to-send applies only with a fine pointer.
