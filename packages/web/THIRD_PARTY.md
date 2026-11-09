# Component notices

Original app code is MIT. Installed dependencies retain their own licenses.

- `src/components/ui/button.tsx`: shadcn/ui, Copyright (c) 2023 shadcn,
  [MIT](licenses/shadcn-MIT.txt). Retrieved from the
  [new-york Button registry](https://ui.shadcn.com/r/styles/new-york/button.json).
- `src/components/ai-elements/conversation.tsx` and `message.tsx`: AI Elements,
  Copyright 2023 Vercel, Inc., [Apache-2.0](licenses/Apache-2.0.txt),
  [upstream notice](licenses/ai-elements-NOTICE.txt). Retrieved from the
  [Conversation](https://registry.ai-sdk.dev/conversation.json) and
  [Message](https://registry.ai-sdk.dev/message.json) registries.
  Conversation is retained; Message is reduced to Message, MessageContent and
  MessageResponse. The role union is local rather than importing the entire AI
  SDK for one type. Unused attachment, branching and action exports are omitted.

Registry sources inspected and retrieved 2026-11-09. These are real component
APIs composed around Dispatch snapshots, not the AI SDK execution protocol.

The standalone frontend archive includes this attribution, the `licenses/` files
and `THIRD-PARTY-NOTICES.md`, generated from the actual bundled dependencies by Vite.
It does not rely on a server/node_modules installation carrying those notices.
