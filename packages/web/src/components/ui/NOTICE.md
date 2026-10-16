# Component source and ownership

The candidate library adapts source from the MIT-licensed
[shadcn chatbot template](https://github.com/shadcn-ui/chatbot-template/tree/4106041b1bc9bab44e81ffd2764aa2b6f100e2b0),
pinned to commit `4106041b1bc9bab44e81ffd2764aa2b6f100e2b0` on October 16, 2026.
The upstream copyright and full license are retained in [LICENSE](LICENSE).
A distributable copy is in [`public/third-party/shadcn-chatbot-template.txt`](../../../public/third-party/shadcn-chatbot-template.txt).

## Adapted source

The following files originate in upstream `components/ui/`:

- `alert.tsx`, `button.tsx`, `collapsible.tsx`, `empty.tsx`, `input.tsx`,
  `select.tsx`, `textarea.tsx`, `tooltip.tsx`.
- `bubble.tsx`, `message.tsx`, `trace.tsx`, `input-group.tsx`,
  `message-scroller.tsx`, `questionnaire.tsx`.

`typeset.css` comes from upstream `app/typeset.css`. The composer layout in
`chat-patterns.tsx` adapts upstream `components/prompt-form.tsx`.

Local adaptations replace Next.js aliases and client directives, map the visual
tokens to Dispatch, adjust control sizes and radii, add coarse-pointer targets,
and preserve keyboard selection styling. Input-group addons can focus a textarea.
The scroller omits the template's application-specific scrollfade helpers.

Dispatch owns `form-controls.tsx`, `overlays.tsx`, `patterns.tsx`,
`chat-patterns.tsx`, the barrel, utilities and semantic token mapping. They compose
the adapted source with Base UI and the existing Dispatch Markdown renderer.
The composer is controlled by its caller; it allows Send during work when a draft
is present and shows Stop when the draft is empty.

## Boundaries and updates

The Next.js application, AI SDK transport, model gateway, authentication, storage,
and deployment wiring were not imported. `@shadcn/react` supplies the headless
Message Scroller and Questionnaire behavior at the version in the lockfile.
Their workshop examples do not establish production acceptance.

When updating, compare each owned file with the pinned upstream version, preserve
the Dispatch behavior and license, update this source record, and review the
affected stories. Do not overwrite this directory with a generated template.
Use [the workshop guide](../../../docs/component-workshop.md) for the public API
and migration workflow.
