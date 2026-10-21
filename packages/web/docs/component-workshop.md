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
reload. Selected and pasted files remain in the tab; supported images are decoded
locally for thumbnails. Nothing is uploaded.

Foundations show color, typography, spacing and reading styles. Controls show
form fields, buttons, dialogs, menus, tabs and feedback. Patterns combine them into
settings sections, resources and message activity. **Prompt form** reviews the
template-derived prompt box independently, including ready, empty, generating,
attachment, failed-upload and disabled states. Its circular actions are shared
with the Chat preview. Experiments expose Message Scroller and Questionnaire
separately. **Start here → Coverage** records
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

`UI.PromptForm` lives in `src/components/ui/prompt-form.tsx` and adapts the
template's `PromptForm` and input-group parts. Its caller supplies the draft,
Send/Stop actions, attachments and optional leading control. `UI.ChatComposer`
remains an alias to that same component. Enter sends; Shift+Enter inserts a line;
IME composition does not submit. A draft can be sent while an agent is working,
and an empty draft reveals Stop. Pending or failed attachments block sending.

The paperclip opens **Add files** and **Add photos**. Both use native multi-file
pickers; the photo picker requests `image/*`, so photo-library and camera choices
depend on the browser and device. Pasting files or images into the message field
uses the same `onFiles` callback; ordinary text paste remains ordinary text.
Callers own validation, upload limits, progress and retry. The picker filter is
a chooser hint, not validation. Supplying the optional `file` on a
`UI.ComposerAttachment` enables local PNG, JPEG, GIF and WebP thumbnails; other
formats or unreadable images retain the file icon and filename. Preview object
URLs are released when the file changes or its attachment leaves the form.

`src/tokens.css` contains the existing Dispatch palette and scale.
`src/components/ui/library.css` maps shadcn semantic tokens and reading presets.
`src/legacy.css` retains the previous application rules. The workshop loads those
legacy rules in a lower cascade layer; the application keeps its original
unlayered cascade. This deliberately leaves coexistence and CSS-layer changes to
the reviewed screen migration. Importing the candidate namespace alone is not a
complete migration.

## Review before migration

The maintainer's review of the candidate system comes before broad application changes.
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
gitignored `.local/workshop/`. No automated tests were added or run. The maintainer's
component-system review and the existing per-screen production acceptance process
remain open; this package accepts no migrated production screen.

### Prompt form follow-up · October 16, 2026

The standalone prompt form and its Chat composition were reviewed at all four
required viewport sizes after restoring circular Send/Stop controls. Interactive
checks covered Send, Stop, a new draft while generating, Enter, Shift+Enter,
empty-submit prevention, failed-attachment retry/removal and disabled controls.
The desktop actions measured 40 × 40 px with a full circular radius. TypeScript,
application and static Storybook builds passed. The extraction retains the IME
guard; physical IME and mobile-keyboard interaction remain unverified. No
automated tests were added or run.

### Attachments follow-up · October 16, 2026

Image paste, plain-text paste, multiple files, the image-only picker, removal and
reselection of the same image were exercised in the built-in Chromium browser.
PNG previews decoded locally; an unreadable PNG retained its file icon and name.
Keyboard menu navigation, image-only Send, sending an image during generation,
Stop, failed-attachment retry and disabled attachment controls passed. Browser
console errors were empty. Source review confirmed object-URL cleanup and kept
validation/upload ownership with callers.

The standalone prompt form and Chat composition were reviewed with image
attachments at 1440×900, 1280×720, 768×1024 and 390×844. TypeScript, application
and static Storybook builds passed. Physical iPhone/Android photo-library and
camera pickers, touch gestures and mobile keyboards remain unverified. These
checks use local synthetic files; they do not exercise a production upload.
Evidence is retained in `.local/workshop/prompt-attachments/`. No automated tests
were added or run.
