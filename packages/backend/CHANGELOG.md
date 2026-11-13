# Changelog

## [Unreleased]

- Carry optional thinking and partialThinking summary text in the shared chat contract.

## [0.13.0] - 2026-11-13

- Connect only to explicit hosts through the shared Runner client, using native watch streams. Remove local writer discovery/startup, duplicate metadata/provenance readers and unqualified installation aliases. Central storage is an optional subpath with optional peers.

## [0.8.0] - 2026-11-12

- Chat messages carry an optional `details` field (a background reply's supporting material).

- Adopt selected definitions for idle local chats after a release update while retaining unfinished work's stored configuration, matching ordinary CLI recovery.

- Open ordinary session stores under the installation's single Pi Durable version record; a Web build carrying an older Pi Durable refuses to own a store instead of running beside a newer runtime.

- Return a newly created or keyed chat only after a discovery pass that started after its native create, so the first message sent right after creation is admitted instead of reported as not found.

- Report each conversation's native `transport`, `addressable` and a typed snapshot `readOnly` reason (worker, internal, owner, unavailable) instead of a generic owner-process warning; do not generate titles for task-run workers. Addressability reflects observed access (worker, unregistered, live legacy owner or unreachable endpoint), including PostgreSQL workers and offline saved snapshots.

- Add lightweight native sidebar summaries and optional persistent AI title metadata without native ownership changes.

- Allow explicitly configured service item-key creation without enabling ordinary creation or submitting messages.

- Always steer active work for ordinary user chat input at native boundaries; keep internal peer/schedule policies and explicit Stop unchanged.
- Align shared Pi dependencies with Runner at 1.5.2 for native Fable 5.2 support; existing installations remain pinned.

- Retain exact-session service restrictions in combined local bindings, including offline snapshots and artifact reads; accept exact-session source roots consistently.

- Resolve native conversation links within exact named installations; expose explicit service restrictions and exclude nested sessions from saved discovery.

- Discover ordinary CLI native owners before writer admission, preserving canonical history IDs and explicit service bindings alongside ordinary sources.
- Compose shared native owners with read-only saved history, canonical identities and live catalogs; support trusted workflow factories without opening replacement owners.

## [0.7.0] - 2026-11-09

- Bind each shared service command/read to its expected native root or stable installation identity, rejecting mismatched socket replacement before dispatch.

- Add public owner-only local service connections, live native observations and file inputs without opening a second storage owner.

- Port reviewed native chat improvements: installation-scoped routing and read-only catalogs, retained tool traces and UTF-8/image input/recovery through local and central workers; refresh current shadcn Web compositions.

- Prepare public npm metadata and the complete reusable runtime closure with dependency-order archives and a separately authorized publishing path.

- Use Runner public native message projection for saved PostgreSQL history so failed generations remain visible without acquiring an owner.

- Extract backend as an independently consumable package with Pi 1.5.0 public contracts, emitted exports and the local central-service/worker composition.
