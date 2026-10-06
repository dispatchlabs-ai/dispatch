# Conversation layout refinement concepts

**Draft for review, October 6, 2026.** Chris requested a comparison of Slack and the current Dispatch Conversations screen, then asked for ImageGen images that closely represent the proposed browser result. These concepts refine the [previously approved shared-conversation design](shared-conversation-designs.md); they are not implementation approval or evidence of running application behavior.

## Main conversation

[![Proposed main conversation layout](assets/conversation-layout-2026-10-06/01-main-conversation.png)](assets/conversation-layout-2026-10-06/01-main-conversation.png)

Use consistent left alignment for the header, message avatars, and composer. Reduce message spacing and sidebar row height, show message actions on interaction, and keep existing reply counts visible. Distinguish agent avatars and present tool activity through readable summaries with expandable technical detail. The right context panel is closed in this state.

## Open thread

[![Proposed conversation with an open thread](assets/conversation-layout-2026-10-06/02-open-thread.png)](assets/conversation-layout-2026-10-06/02-open-thread.png)

The same workspace opens the selected message's thread in the right panel. The parent message, replies, activity, and thread composer remain visually connected. The main conversation keeps its own composer and header. Participants remain accessible from the header; selecting an agent can reveal its configuration.

## Scope and review

These desktop concepts retain Dispatch's light navy/aqua identity, project groups, inline mentions, and arrow-only send button. Unread tracking, mention notifications, reactions, message-content search, and new agent attention states require separate product decisions and are not added by these images.

Generated with the built-in ImageGen tool using the [recorded prompt set](assets/conversation-layout-2026-10-06/prompts.json). Source attachments are not committed. Names, sample messages, timestamps, and statuses are illustrative, not records of new agent actions.

Images are raster implementation references, not rendered browser captures or pixel specifications. Visual review covers alignment, density, readable text, and consistency between states. Interaction, keyboard and touch access, responsive layouts, measured contrast, and runtime behavior remain unverified. This task changes design documentation only and runs no tests.
