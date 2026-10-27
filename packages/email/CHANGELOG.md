# Changelog

## [Unreleased]

- Extract the Gmail transport from Runner while retaining native task identities,
  conversation bindings, file custody and a compatibility adapter entry point.
- Default each address to receive-only until sending is explicitly enabled. Admit
  all sender types and fan out multi-address mail; create labels and file unrouted
  and sent mail without requiring external Gmail filters.
- Add durable email sending from any agent conversation, including scheduled
  work, with explicit recipients, replies/reply-all, HTML and attachments. Expose
  account enablement and delivery status; prevent tool retries and final-answer
  replies from duplicating explicitly queued mail.
- Remove attachment budgets, filename cutoffs, quoted-body trimming and implicit
  HTML-input truncation. Preserve actual provider errors and file-integrity checks.
- Reconcile uncertain new sends as well as replies; recheck sending enablement
  before sending recovered queued work. Existing attempted deliveries still get
  reconciled and filed without blindly retrying.
