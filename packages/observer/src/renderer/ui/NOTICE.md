# Component source and ownership

The Observer primitive library adapts source from the MIT-licensed
[shadcn chatbot template](https://github.com/shadcn-ui/chatbot-template/tree/4106041b1bc9bab44e81ffd2764aa2b6f100e2b0),
pinned to commit `4106041b1bc9bab44e81ffd2764aa2b6f100e2b0` on October 16, 2026.
The upstream copyright and full license are retained in [LICENSE](LICENSE).
The distributable copy is retained in [LICENSE](LICENSE).

## Retained source

Observer retains Button, Input, Select, Collapsible, Message, Trace, Table and
Breadcrumb primitives with their local utilities. Dispatch owns `form-controls.tsx`,
`overlays.tsx` and the barrel. Unused retired Web patterns/composers are not shipped.
`library.css` and `typeset.css` retain the upstream token/type styling notices.

The Next.js app, AI SDK transport, authentication/storage and deployment wiring
were not imported. Compare owned files with the pinned source when updating;
preserve local behavior and notices. Observer owns this library independently of
Web's replacement shadcn/AI Elements presentation.

## Observer process navigation — November 4, 2026

`table.tsx` and `breadcrumb.tsx` adapt the MIT-licensed shadcn/ui Base Nova
registry sources at [Table](https://ui.shadcn.com/r/styles/base-nova/table.json)
and [Breadcrumb](https://ui.shadcn.com/r/styles/base-nova/breadcrumb.json),
retrieved November 4, 2026. Local changes resolve the shared `cn` utility and
Lucide icons. They are exposed through the existing shared UI entry point;
the replacement Web has a separate component library.
