# Agent Chat design

- Local-first, single-user chat. Dispatch/Pi Durable owns execution and authoritative history; this app owns presentation and its adapter.
- Prioritize messages and primary actions: compact agent/conversation navigation, compact composer, useful running/tool/error states, and a visible stop action.
- Use readable Markdown and code, restrained neutral colors, consistent spacing, accessible names and keyboard focus. Support narrow and desktop layouts without horizontal page overflow.
- Prefer React and shared shadcn/ui primitives with suitable AI Elements conversation, message and prompt patterns; use actual component APIs, not copied speculative signatures.
- The backend alone handles configuration and provider/tool credentials. Bind loopback and enforce same-origin and allowed-host boundaries on tool-capable requests.
- Observe only startup-configured native stores without opening runtimes. Acquire a compatible native owner lazily on explicit create/send/stop; preserve historical stores and external owners. Browser reconnection observes rather than resubmits work; use native request identities for submission replay.

Implementation must link its concrete component and token sources here as they are established.

## Concrete sources
- Shared [shadcn Button](src/components/ui/button.tsx) and [AI Elements
  Conversation](src/components/ai-elements/conversation.tsx) / [Message](src/components/ai-elements/message.tsx), with source links and notices in [THIRD_PARTY.md](THIRD_PARTY.md).
- [Tailwind theme tokens and responsive layout](src/styles.css): warm neutrals,
  muted green primary, compact 60px desktop/52px mobile header, 820px reading
  width, visible focus. Streamdown renders Markdown/code with HTML sanitization;
  remote images and connections are blocked by the local Content Security Policy.
- The composer is a native accessible form, not an AI SDK transport. Enter sends,
  Shift+Enter adds a line, and IME composition does not submit. No parallel AI loop.
