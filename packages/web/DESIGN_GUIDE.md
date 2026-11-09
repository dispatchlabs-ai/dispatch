# Web chat design

- Consumer-authored native agents, credentials and authority stay outside Web.
  Runner/Pi owns execution, durable conversations, content blocks and recovery.
  Backend provides the same local and central PostgreSQL/outbound-worker operations.
- Current official shadcn Chat/Message/Message Scroller, Bubble, Trace/Code Block,
  Prompt Input/Input Group/Attachment and Sidebar menu primitives are composed
  with real APIs. See [notices and immutable sources](THIRD_PARTY.md). No Next,
  AI SDK, Gateway or second execution loop is imported.
- Restrained neutral colors, readable streaming Markdown/code, compact searchable
  history, circular Send and visible native Stop. Busy follow-ups remain available;
  send/stop are not a cosmetic toggle that removes follow-up input.
- Actual tool IDs/turns/assistant entries, retained arguments/results/errors and
  native task/live state drive expandable activity. Missing result is unavailable,
  not success; only native evidence establishes cancellation, waits or parentage.
  No fake approvals or questionnaire parsed from ordinary prose.
- Files show removable chips/image previews before admission and retained download
  links afterward. Browser names are labels only. Supported UTF-8 documents and
  PNG/JPEG/WebP images enter native Pi blocks, not a shadow transcript/blob DB.
- Per-tab IndexedDB is only the local draft/uncertain delivery outbox. Preserve
  text, bytes and requestId across reload/rejections; replay explicitly with the
  original identity. Reconnect only observes. No arbitrary attachment/message caps;
  format/model/provider constraints remain explicit.
- Enter sends, Shift+Enter/IME do not. Focus restores after send without stealing
  intentional navigation. Keyboard focus visible on search/tool/code controls;
  mobile drawer traps focus, Escape restores it, hidden areas inert.
- Configured installation/agent/conversation IDs stay exact. Compact visible
  labels do not erase identity; source/session/native ID remain searchable or in
  metadata. All native histories remain reachable, without truncation caps.
- Observe configured native history without owners/providers/resume. Only explicit
  compatible mutations acquire ownership; retain old definitions/host/state on
  mismatch. Host/Origin/Fetch Metadata and real hosted authorization protect every
  read/write/SSE operation, including new content. CSP allows same-origin/data
  image previews, blocks remote images/connections and arbitrary HTML execution.

Qualification is four viewports (1440×900,1280×720,768×1024,390×844) plus real
keyboard/mobile/scroll/recovery and native local+PG/worker interaction, not visual
resemblance or build success alone. Production tools/models/identity/TLS/cloud
installation remain consumer qualification; no unrelated deployment claim.
