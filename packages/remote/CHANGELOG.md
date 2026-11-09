# Changelog

## [Unreleased]

- Prepare public npm metadata and the complete reusable runtime closure with dependency-order archives and a separately authorized publishing path.

- Export the shared StorageRequest parser/allowlist for service-side PostgreSQL composition; existing SQLite relay semantics remain unchanged.


- Upgrade source client/service dependencies to Pi 1.5.0 and implement grouped commits, validated ordered receipts and durable partial-refusal retries.
- Persist ID allocation with its mutation receipt and conservatively reserve earlier numeric receipts on open; preserve explicit owner retirement and uncertain-outcome shutdown.
- Require matching client/service revisions; retain schema 2 and pre-upgrade backups. The new wire contract has not been qualified on a live installation.

- Add optional outbound relay routing, a Pi Durable 1.4.0 remote Storage client,
  and a SQLite service using native Pi storage and transactional write receipts.
- Require explicit owner retirement after an unclean runner shutdown; retain
  retired session identities to reject later reuse.

## [0.6.0]

Development baseline; this package has no published release artifact yet.
