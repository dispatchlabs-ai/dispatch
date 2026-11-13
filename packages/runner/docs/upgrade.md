# Upgrading a machine

`dispatch-upgrade` moves every consumer of Dispatch-based agent releases on one
machine to the releases selected for it. It is for an operator, or the
infrastructure automation, of a machine that runs releases built with
[`mkAgentRelease`](nix-releases.md) from Nix profiles, with macOS launchd or
Linux systemd supervising any services.

One machine runs one Pi Durable version. Sessions follow the selected release
once idle, earlier releases are removed, a closed-state backup is part of the
upgrade, and going back means restoring that backup. Runner already enforces
[one Pi Durable per state root](service.md#one-pi-durable-per-state-root); this
command applies the same rule to everything installed on the machine.

The command ships in the Runner package as `bin/dispatch-upgrade`, and every
release with the default launcher runs its own Runner's copy as `NAME upgrade`.
It is a separate program, not a `dispatch-agent` subcommand, because it works
across releases and state roots while `dispatch-agent` serves one definition
root. Run the copy that belongs to the selected release: taking a state root to
a new Pi Durable uses that Runner's own selection lock.

```sh
company-agents upgrade status    --declaration /etc/dispatch/machine.json
company-agents upgrade preflight --declaration /etc/dispatch/machine.json
company-agents upgrade converge  --declaration /etc/dispatch/machine.json
```

## Declaration

The machine declares what is selected and what runs it. Nothing about an
installation is built into the command. A company repository knows its own
consumers (its `deployments.nix` already records `profile`, `stateRoot`,
`config` and its supervision); infrastructure supplies the host facts: the
selected store paths, absolute paths and unit names. Infrastructure writes the
file; it contains no secret.

```json
{
  "schemaVersion": 1,
  "stateDirectory": "/var/lib/dispatch-upgrade",
  "releases": [
    {
      "name": "company-agents",
      "package": "/nix/store/STORE-company-agents-0123456789ab",
      "consumers": [
        { "name": "cli",
          "profile": "/home/operator/.local/state/nix/profiles/company-agents",
          "config": "/etc/company-agents/host.json" },
        { "name": "assistant",
          "config": "/etc/company-agents/service.json",
          "supervision": { "kind": "systemd", "unit": "company-assistant.service", "scope": "system" } }
      ],
      "companions": [
        { "name": "web",
          "package": "/nix/store/STORE-dispatch-web-0.10.2",
          "profile": "/home/operator/.local/state/nix/profiles/company-web" }
      ]
    }
  ],
  "retire": [
    { "supervision": { "kind": "systemd", "unit": "company-prototype.service" } },
    { "profile": "/home/operator/.local/state/nix/profiles/company-agents-trial" },
    { "path": "/srv/company-prototype/node_modules" }
  ],
  "records": ["/var/lib/company-status/*"]
}
```

| Field | Meaning |
| --- | --- |
| `stateDirectory` | Where this command keeps `receipts/`, `backups/`, `retired/` and garbage-collector `roots/`. |
| `releases[].name`, `package` | The release name and its selected store path. A profile or link is accepted and means "what it selects now". The package's `share/NAME/release.json` supplies the revision, Dispatch version and Runner. |
| `consumers[].profile` | A Nix profile that runs the release, such as the on-demand launcher's. Converge selects the package in it. |
| `consumers[].stateRoot`, `config` | The state root the consumer opens. With `config` (its host or service JSON), `stateRoot` and a service `socket` are read from that file. |
| `consumers[].supervision` | A supervised service: `kind` is `launchd` or `systemd`, `unit` the label or unit name, `scope` `user` (default) or `system`, and `definition` the plist or unit file when it is not in the standard place. Restart is always stop then start through that supervisor, which re-reads the definition. |
| `companions[]` | Other packages that must carry the release's Pi Durable, such as Web or a model provider built from the same Dispatch revision; optionally a `profile` that converge selects. Every package holding a Pi Durable that a declared service names must be the release, its Runner or a companion. |
| `retire[]` | Exactly one of: a `supervision` to stop and whose definition is moved into `retired/`; a `profile` to remove with its generations; a `path` (a link is removed, a directory is moved into `retired/`). State and configuration are never touched. |
| `records[]` | Globs of files whose contents are history, such as status output, rather than dependencies. |

A supervised service reaches its release through whatever its definition and
configuration name. Point them at a declared profile, which converge moves, or
have infrastructure rewrite them to the selected store path before running the
command. A definition that still names an earlier package is reported, not
edited. A `dispatch-service` whose release changes definitions needs
`"updateDefinitions": "when-idle"` in its configuration, otherwise it refuses to
start on the new release and converge reports it as not staying up.

## What each command does

`status` and `preflight` change nothing; `status` does not even ask a running
owner anything.

- **status** prints, for each declared release, its revision, Dispatch version,
  Pi Durable and evaluation package, and each consumer's profile, service
  and state root with their running state; then any other installed service or
  running process that loads Pi Durable, and the last receipts. `--json` gives
  the same as data.
- **preflight** refuses the machine, naming each reason, when a selected package
  is missing or is not that release; a release or companion carries more than
  one Pi Durable, or two releases need different ones; a state root was opened
  by a newer Pi Durable; a declared service has no installed definition or still
  names an earlier package; or a consumer that would restart has unfinished
  work. Otherwise it lists what would move. Unfinished work is Runner's own
  definition: a running session owner or service is asked for its `status`, and
  a closed store is read without being opened for writing.
- **backup** closes each declared state root (services through their
  supervisor, idle session owners with their ordinary shutdown), copies it,
  verifies the copy and restarts the services that were running. Disabled,
  stopped services stay stopped.
- **converge** runs the preflight and stops there, changing nothing, if it
  refuses. Otherwise it stops the services that must restart, closes idle
  session owners that are on another runtime or an earlier release, takes the
  backup wherever the Pi Durable version changes (always there, and everywhere
  with `--backup`), records the new version for those state roots, selects the
  packages in the declared profiles, starts the services, applies `retire`,
  removes what the selection supersedes, and then inspects the machine again.
  It fails unless every declared profile selects its package, every declared
  service stays up, and no installed service definition, supervised process or
  session owner can load another Pi Durable. A second run changes nothing.
- **restore** `--from BACKUP [--to STATE_ROOT]` verifies a backup and puts it in
  place of a closed state root, keeping the replaced root beside it as
  `ROOT.replaced-TIME`.
- **inventory** prints the installed service definitions as data. Run it with
  privilege and pass the result to the other commands as
  `--system-inventory FILE` when the upgrading user cannot read system units.

A session owner with unfinished work on the same Pi Durable is left alone: it
keeps its earlier release until idle, and that release stays on the machine,
rooted against garbage collection, until a later converge finds it idle. With a
Pi Durable change, or a requested backup, unfinished work refuses the upgrade
instead: let it finish or stop it first.

Exit status is 0 when ready or converged, 1 when refused or when the machine
does not verify, and 2 for a usage or declaration error.

## Backup and rollback

A backup is `stateDirectory/backups/NAME-ID-TIME/` holding `state/`, a complete
copy of the state root without sockets and lock files, and `backup.json` with
the source, the Pi Durable that owned it, each file's size and SHA-256, and the
owner, group and mode of every file, directory and symlink. Restore prepares and
verifies a replacement before moving the existing root, and requires permission
to reproduce the recorded ownership. Older backups without that record retain
the ownership of their backup copy. It is
taken under the lock every Runner takes before opening a store in that root,
after everything that owns stores there has closed and before the new version
is recorded. It is verified before the upgrade continues: every file's digest
against the closed source, the file count, and SQLite's own check of every
store. Backups are not pruned.

Rolling back is a restore, not a profile switch, because the newer Pi Durable
may have migrated the stores: stop the consumers, run `restore --from BACKUP`,
select the earlier packages again and start the consumers. A release built
before this command existed has no `upgrade` of its own; select it with
`nix-env --profile PROFILE --set` and its supervisor.

## Removal and what is kept

Converge removes only what this installation selected before: earlier
generations of the declared profiles, retired profiles, and packages named in
earlier receipts, together with their Runners. It never searches the store by
name. A candidate stays when the selection contains it, when any installed
definition, its configuration or any running process still names it, or when Nix
refuses because something outside the declaration still refers to it. The
receipt lists each one kept and why.

## Receipts

`backup` and `converge` write `stateDirectory/receipts/TIME-MODE.json`:
the selection (`selected`, `piDurable`), `problems` when refused, `planned`,
`changed`, `backups`, `removed`, `retained` with reasons, `failures`, and the
inventory after the run (`services`, `running`, `stateRoots`, `profiles`,
`onAnotherPiDurable`, `notRunning`, `missing`, `unresolved`, `uninspected`).
`preflight --json` prints the same shape without writing it.

## Limits

- Requires Nix (`nix-env`, `nix-store`) and POSIX. Verified on macOS (Apple
  silicon) with launchd user agents and synthetic releases. The systemd
  supervisor and `--system-inventory` are implemented and type-checked but have
  not been run on Linux.
- Services that run in containers are listed as not inspected; their images are
  not searched for a runtime.
- Template units (`name@.service`) are not expanded; declare each instance.
- A workspace session pinned to its release's runtime is not found by this
  command. Finish or suspend such sessions before a Pi Durable change, as
  [service](service.md#one-pi-durable-per-state-root) describes.
- The command does not build or copy releases, edit service definitions or
  configuration, or migrate definitions for a service.
