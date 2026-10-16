# Component workshop

The workshop is a local Storybook for reviewing the shared Dispatch UI before
applying it across the application. It contains actual reusable React components,
synthetic Chat and Agent Editor compositions, and a coverage map of the existing
screen inventory. It does not start the backend or change live agents and chats.

## Run and review

From the repository root:

```sh
nix develop
npm ci
npm run workshop
```

Open <http://127.0.0.1:6006/?path=/story/start-here--overview>. Follow the repository
startup guidance before reinstalling dependencies into a running checkout. The
workshop binds only to loopback and can run alongside the application. It needs no
account or model credentials.

Start with **Screens → Chat → Conversation** and **Screens → Agent editor →
Editable**. Their sidebar variants cover empty, failure and read-only states.
Sending, stopping, reconnecting, attachment retry/removal, resource assignment,
field validation and saving are local preview interactions. Changes reset on
reload. A chosen attachment contributes only its name and size; its bytes are not
read or uploaded.

Foundations show color, typography, spacing and reading styles. Controls show
form fields, buttons, dialogs, menus, tabs and feedback. Patterns combine them into
settings sections, resources, message activity and a composer. Experiments expose
Message Scroller and Questionnaire separately. **Start here → Coverage** records
which patterns could serve each screen and what still needs design or validation.
An available example is not a migrated or accepted production screen.

Use Storybook's open-canvas-in-new-tab action to review the full viewport at
1440×900, 1280×720, 768×1024 and 390×844. The controls panel is hidden initially;
enable it from Storybook's toolbar when inspecting component arguments.

`npm run build:workshop` writes `packages/web/build/workshop`. A later application
build can clear this directory; rebuild the workshop afterward. `npm run check`
checks application types and builds. `nix build` and `nix flake check` also check
the static workshop, then omit it from the installed application artifact.

## Source and public interface

[Source provenance](../src/components/ui/NOTICE.md) identifies the pinned chatbot
template, copied files, local adaptations and retained MIT license. This is source
reuse, including its message, bubble, trace, input-group and Typeset components.
The existing Pi runtime and Dispatch application wiring retain their ownership.

Import candidate components through the existing public facade:

```tsx
import { UI } from "../components/ui";

<UI.SettingsSection title="Identity">
  <UI.Field label="Description">
    {(field) => <UI.Input {...field} />}
  </UI.Field>
</UI.SettingsSection>
```

Implementations live under `src/components/ui/`; `src/components/ui.tsx` exports
the `UI` namespace alongside its unchanged legacy API. Components own presentation
and accessibility; callers own data, permissions, persistence and async actions.
Stories import the same components, rather than maintaining a second preview UI.

`src/tokens.css` contains the existing Dispatch palette and scale.
`src/components/ui/library.css` maps shadcn semantic tokens and reading presets.
`src/legacy.css` retains the previous application rules. The workshop loads those
legacy rules in a lower cascade layer; the application keeps its original
unlayered cascade. This deliberately leaves coexistence and CSS-layer changes to
the reviewed screen migration. Importing the candidate namespace alone is not a
complete migration.

## Review before migration

Chris's review of the candidate system comes before broad application changes.
The live database specification remains authoritative. The coverage map and this
guide are implementation aids, not a second specification.

For each authorized screen, reuse or extend a shared component, add useful state
examples, and check the actual application at the four viewport sizes plus its
keyboard, touch and recovery flows. Reconcile the cascade deliberately and remove
superseded rules only after their callers have migrated. Record acceptance in
[UI/UX review](ui-ux-review.md); retain unresolved gaps in the coverage map.

In particular, Message Scroller still needs qualification against Dispatch's
virtualization, reconnects, thread switching, expanding media and long histories.
Typeset needs representative real chat and document content. Rich editing, code
and diff viewing, repository pickers, permission matrices and revision conflicts
remain separate work. The workshop makes those gaps visible rather than claiming
full application coverage.

## Verification receipt · October 16, 2026

- `npm run check`, `nix build` and `nix flake check` passed on Apple Silicon macOS
  after reconciliation with `49ca048`. The Nix check built Storybook successfully;
  the installed application excludes the workshop and includes the template's
  license notice. Incompatible Linux systems were not built in this pass.
- The overview, Chat and Agent Editor were reviewed as whole layouts at all four
  required viewport sizes. Narrow layouts were also inspected for forms, dialogs,
  reading content, long resource names, the coverage map and Questionnaire.
- Interactive checks covered Send while running, Stop, failed attachment retry
  and removal, reconnect draft retention, empty-chat suggestions, editor validation,
  local save/retry, skill assignment, reset, read-only controls, keyboard select,
  tabs, menu feedback, dialog dismissal and focus return. Checkbox and switch
  interactions passed; emulated coarse-pointer inputs and selects measured 44 px.
  Physical touch gestures, mobile keyboards, Safari and Firefox remain unverified.
- In the scroller fixture, the same message stayed within 0.25 px of its prior
  position after append/prepend, and jump-to-latest settled within 0.5 px of the
  end. Questionnaire required-answer validation, a selected choice and a free-text
  answer worked. These are fixture results, not live chat acceptance.
- Source review confirmed that the extracted legacy rules preserve their previous
  declarations apart from the two token-name substitutions. The existing Markdown
  API retains its default class. The new library and stories contain no backend
  calls. The simplification review kept state in the examples and data/transport
  ownership with callers rather than adding a second application service.

Sanitized captures and command receipts are retained in the task worktree's
gitignored `.local/workshop/`. No automated tests were added or run. Chris's
component-system review and the existing per-screen production acceptance process
remain open; this package accepts no migrated production screen.
