# Upgrade an application

Dispatch is a normal application dependency. Select a new published package
version or immutable release archive, update the application's lockfile, and run
its build and relevant checks. For an application using only Runner:

```sh
npm install https://github.com/dispatchlabs-ai/dispatch/releases/download/v0.21.0/dispatch-runner-0.21.0.tgz
```

Commit the updated `package.json` and `package-lock.json`. For a later release,
substitute its version in the URL; installed library names and application imports
stay the same. Install matching optional channel packages together.

For Nix applications update the pinned Dispatch
input and build the resulting closure.

Stop the application's host through its existing supervisor. Preserve its state
with your normal backup procedure, then restart that host from the new application
build. Clients reconnect; they do not select versions, stop other processes or
launch replacement owners. Runtime updates do not edit agent definitions.

Use a single dependency tree per application. Check the selected release's Pi
version and storage compatibility before opening retained stores; do not point
an older runtime at state it cannot read. Deployment, backups and rollback belong
to the application operator. Dispatch supplies no machine upgrade or migration
machinery. Publishing source does not upgrade any running installation.

## Upgrading from 0.18 to 0.19

Version 0.19 adds `dispatch login`, `dispatch auth`, `dispatch logout` and
`@dispatch/runner/local-provider`. Plain `dispatch serve` automatically uses saved
sign-ins before environment API keys. Sign in once with `npx dispatch login openai`
on the host's computer to use a ChatGPT subscription.

An explicit `environmentProvider` binding remains API-key-only. To use saved
sign-ins, change its module to `@dispatch/runner/local-provider` and export to
`localProvider`, keeping its provider `args` and other host settings. Application
code can import `localProvider` from that subpath. Restart the host after changing
its bindings or account. See [sign-in setup](sign-in.md).

Pi remains pinned to 1.5.2. This release does not change the native store version
or migrate application definitions. Review the usual backup and restart steps
above before upgrading an existing installation.

## Agent definition changes

Changing `agent.md`, `agent.ts`, shared instructions or enabled skills is a
definition update, not a package upgrade. A plain host refuses changed definitions
against retained state unless you explicitly configure `updateDefinitions`.

The [application setup](create-agents.md#edit-or-add-an-agent) uses
`"updateDefinitions": "when-idle"` in `host.json`: restart the host after edits,
and it applies them when existing work is idle, preserving history. It is not a
file watcher. `true` applies updates only when the saved work is already idle;
`"when-idle"` can defer them while recovery completes. The host then warns that
existing conversations keep their saved definition while new conversations use
the edited one; restart again after that work finishes to update them. Finish or
explicitly stop work before editing when you need the change to take effect at
the next start.

### Unsupported frontmatter keys

**Breaking in the release after 0.20.0.** Runner now rejects `agent.md`
frontmatter keys it does not read. Earlier versions ignored them, although they
still changed the definition fingerprint. Before upgrading, check every
`agent.md` and handle each extra key by what uses it:

| The key is | Do this |
| --- | --- |
| A Dispatch setting in the wrong file, such as `messages`, `skills` or `schedules` | Move it to `agent.ts` with `defineAgent`. |
| A descriptive note for people or the model, such as `writes: none` | Move the note into the instruction body, where the model can read it. Rewrite it as guidance if it should affect behavior. |
| Configuration your application's own code reads from the file | Move it to an application-owned file, such as a JSON file beside the agent or a module the reader imports, and change the reader in the same commit. Removing the key alone breaks that reader. |

`dispatch catalog` reports the first unsupported key in each definition without
starting a host or opening stores. Moving text into the instructions, or any
change to `agent.md` or `agent.ts`, is a definition update; apply it with the
procedure above.

Demo and live execution cannot share a store, regardless of `updateDefinitions`.
Use `.demo/` for synthetic work and `.state/` for real models. Keep the original
store when changing execution mode.
