---
name: slack-output
description: Format Slack-facing replies with working links, lists and tables. Distinguish the shared Markdown reply path from direct Slack mrkdwn or Block Kit payloads.
---
# Slack output

## Choose the receiving format

Normal replies through `@dispatch/slack` use **standard Markdown**, including
streaming and final answers. Do not convert them to Slack `mrkdwn`, HTML-escape
them, or return Block Kit JSON as prose.

For an explicit Slack posting tool, API payload or automatic report, follow its
declared format instead. A `mrkdwn` field uses `<https://example.com|label>` and
`*bold*`; a `markdown` block uses `[label](https://example.com)` and `**bold**`.
Native blocks require the tool's schema. Do not mix these contracts.

## Workflow updates

Lead with a bold work-item and current-stage heading, such as
`**TASK-123 · Code review**`. Name the work being performed: planning and
coordination, implementation, code review, acceptance testing or deployment.
Concurrent workers may report different stages. Omit a repeated bot name such
as “Jett:” and omit emojis.

Use short labeled paragraphs or bullets for relevant results: **Passed**,
**Running**, **Correction**, **Blocked** and **Next**. Include only labels
supported by the evidence; a progress update need not fill every section.
Keep meaningful corrections and unresolved requirements visible. Put detailed
commands, hashes and evidence behind useful links when available.

If the host already supplies the stage heading, return only the labeled body.
For example, a worker can report:

```markdown
**Passed:** Recipient focus checks in both browser engines.

**Running:** Independent review of the same candidate.

**Next:** Assess the remaining release requirements.
```

Post a fresh update for a meaningful result, correction or blocker. When the host
supports editable status, keep unchanged waiting activity in that status rather
than repeatedly posting it. Presentation does not change verification scope or
turn a completed check into approval of the whole task.

## Normal replies

- Use `[label](https://example.com)` in prose, bullets and table cells. The
  shared adapter escapes `<url|label>` into literal text; bullets are not the issue.
- Use Markdown headings, emphasis, lists and blockquotes as useful. Keep code
  in inline backticks or fenced blocks; markup inside code stays literal.
- Use pipe tables with a header and separator row. Do not code-fence a table or
  link that should render. These fences illustrate the source to send:

```markdown
- [TASK-123](https://example.com/issues/123) — Ready for review.

| Item | Status |
| --- | --- |
| [TASK-123](https://example.com/issues/123) | Ready for review |
```

Large indivisible blocks can fall back to literal text when the adapter chunks
them. When splitting a large table, split between rows and repeat the header in
each separate table; preserve complete lists and code fences where possible.
Do not claim arbitrary-size tables will retain formatting.

The adapter preserves native member mentions (`<@USER_ID>`) outside code but
keeps broadcast tags literal. Do not turn an ordinary name into a notification.

[Slack Markdown blocks](https://docs.slack.dev/reference/block-kit/blocks/markdown-block/)
and [Slack mrkdwn](https://docs.slack.dev/messaging/formatting-message-text/)
define the two formats. This skill changes presentation, not posting authority.
