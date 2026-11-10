# Component notices

Original Web code is MIT. Installed dependencies retain their own licenses.

- Current shared `src/components/ui/{message-scroller,message,bubble,input-group,
  attachment,trace,code-block,collapsible,input,textarea,sidebar}.tsx`: adapted
  from [shadcn/ui](https://github.com/shadcn-ui/ui/tree/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/bases/radix/ui),
  Copyright (c) 2023 shadcn, [MIT](licenses/shadcn-MIT.txt).
  Source pin `8ab27715521cbd4f87ae6886cd989cbb678f6de7`, retrieved 2026-11-09.
  Registry imports/icons are resolved locally. Their `cn-*` appearance rules are
  copied verbatim from the registry style
  [`style-vega.css`](https://github.com/shadcn-ui/ui/blob/8ab27715521cbd4f87ae6886cd989cbb678f6de7/apps/v4/registry/styles/style-vega.css)
  at the same pin into `src/shadcn-style.css` (un-nested, used classes only), with
  the standard shadcn neutral tokens. Sidebar selects menu primitives and retains the app's accessible drawer
  rather than adding cookie state. Scroller uses `@shadcn/react` **0.3.1**.
- `src/components/ui/button.tsx`: shadcn/ui new-york Button (MIT), with current
  icon size variants. Same upstream copyright/license.
- The previous Vercel Conversation/Message copies have been replaced by current
  [Chat](https://ui.shadcn.com/docs/ai-elements/base/chat) and
  [Prompt Input](https://ui.shadcn.com/docs/ai-elements/base/prompt-input)
  compositions. Historical Apache-2.0 license/notice files remain available.
- Markdown uses Streamdown (its installed license), not an execution transport.

Official Tool composition uses Trace and Code Block. Native tool calls map to
these APIs; no AI SDK, AI Gateway, synthetic tools or prose-parsed questionnaire.
The chatbot template commit `4106041b1bc9bab44e81ffd2764aa2b6f100e2b0`
was a reference only, not adopted as an execution backend.
