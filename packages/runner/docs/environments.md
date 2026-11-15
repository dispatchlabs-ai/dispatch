# Execution environments

An agent selects an application-owned Nix recipe. Runner builds its software,
prepares a persistent instance and supplies its Cua tools through the same host
that serves terminal, Web and messaging clients. Agent execution and conversations
stay in Pi Durable. Native coding tools still operate on the host.

Environment support is optional. Ordinary agents require neither Docker nor Nix.
The desktop setup path requires Node 24.22.1+, Git, a running local Docker engine and
the [Cua CLI](https://github.com/trycua/cua) on PATH (qualified with 0.18.0).
Docker runs the pinned Linux Nix builder, including on macOS; a separate host Nix
installation, remote builder, application flake and second application runtime
are unnecessary. The bundled desktop base is Linux ARM64. An existing Cua Space
can be attached from other hosts; an alternate pinned image can also be supplied
to `mkCuaDesktop` through `baseImage`.

## First desktop

Create `environments/base.nix`:

```nix
{ pkgs, environments }:
{
  packages = [ pkgs.unzip ];
  extensions = [ environments.bitwarden ];
  chromiumPolicy.PasswordManagerEnabled = false;
}
```

Create `agents/researcher/environment.nix`:

```nix
{ pkgs, environments }:
let base = import ../../environments/base.nix { inherit pkgs environments; };
in environments.mkCuaDesktop (base // {
  name = "research-browser";
  packages = base.packages ++ [ pkgs.pdfgrep ];
  startUrl = "https://example.com";
  chromiumPolicy = base.chromiumPolicy // {
    DownloadDirectory = "/home/cua/Downloads/research";
  };
})
```

Add the selection to the agent's existing Markdown frontmatter:

```yaml
environment: { recipe: agents/researcher/environment.nix }
```

Alternatively, add the same `environment` object to `defineAgent` in `agent.ts`.
Paths are relative to the application root. Recipes are trusted source code;
they receive pinned `pkgs` and shared `environments` builders. Keep credentials,
machine addresses and browser profiles outside recipes and their imported files.
The builder snapshots Git's tracked and nonignored worktree files, including new
recipes before commit. Host settings, local settings, environment files, dependencies,
`.state` and the configured host state directory are excluded. Keep other private inputs ignored; source links must
resolve within the repository. There is no live-checkout mount in the builder.

After installing the Runner package that contains this feature:

```sh
npx dispatch environment describe --agent researcher
npx dispatch environment setup --agent researcher
npm start
```

Setup builds the image with Nix, loads it into Docker, creates separate home and
control-token volumes, opens a loopback port, waits for the desktop health check,
registers it with Cua and saves the agent's private binding. Chromium opens
automatically with the configured page and extensions. The first build downloads
the pinned inputs and may compile patched packages. Subsequent agents reuse the
Nix store and image layers, with independent writable sessions.

Use the application's existing `npm run chat` or `npm run web`. Ask the agent to
open its environment viewer, inspect the desktop, or run a harmless command there.
The host supplies `space_bash`, `space_write`, `list_tools`, `call_tool`, `upload`,
`download` and `open_space_viewer` through Pi's MCP client. The Space argument is
bound by the host and omitted from model input. GUI operations use the installed
Cua driver's discovered schemas. Shell calls have no automatic deadline and
remain cancellable. This target binding is not an OS sandbox for host coding tools.

Sign into private services in the desktop and verify the account identity.
To configure a self-hosted Bitwarden server and record an expected account:

```sh
npx dispatch environment stop --agent researcher
npx dispatch environment setup --agent researcher \
  --vault-server https://vault.example.com --identity researcher@example.com
```

Those values belong in private host state, not the Nix store or software image.
For a new instance, pass them on the first setup command and omit stop.
Existing Bitwarden and keyring sessions may still need unlocking after restart.
Setup does not copy another desktop's credentials or claim that websites are
authenticated. Host-side integrations remain configured on the existing host.

## Attach an existing computer

```sh
cua spaces ls --json
npx dispatch environment setup --agent researcher --space local:research
npm start
```

This path uses the existing registered computer and credentials. It does not
rebuild it, copy its profile or assume its software matches the recipe. Check its
installed tools before using it. It applies equally to registered desktops,
containers, sandboxes and VMs, local or remote; their existing owner retains
provisioning and lifecycle. The owner must make the selected Space reachable
from the host running Dispatch. Explicitly attaching the same Space to another
agent shares its writable computer; ordinary setup creates an independent one.

## State, upgrades and lifecycle

Commands read the same `host.json` as the application and accept `--config`,
`--root` and `--state`. Bindings and optional settings live in the host's
`stateRoot/environments/<agent>/`, with owner-only permissions. Cua stores its
control credential in its own private credential store. The binding records the
Docker context, container, image and selected Space; it contains no control token.
Never commit these directories. Keep the host state path stable across restarts.

```sh
npx dispatch environment status --agent researcher
npx dispatch environment stop --agent researcher
npx dispatch environment start --agent researcher
```

Host startup starts an already configured managed desktop and refreshes its Cua
registration if the port changed. An unconfigured selection leaves ordinary chat
available and tells the agent that environment setup is needed. Host shutdown
does not delete or stop the desktop. Stop the host before deliberate desktop
maintenance so it cannot start the desktop or keep a stale connection.

After changing a recipe or installing a newer Runner package, close active
browser work, stop the host and rebuild:

```sh
npx dispatch environment stop --agent researcher
npx dispatch environment setup --agent researcher --rebuild
npm start
```

The rebuilt container keeps its home and control identity. Disk persistence does
not preserve RAM, keyring unlock state or every website session. Keep a backup of
valuable profiles before an application upgrade. No destructive volume-removal
command is part of ordinary setup or shutdown.

`environment build` builds and loads an image without creating or replacing an
instance. The named `dispatch-nix-<system>` Docker volume is a reusable build
cache. Application private instance volumes have distinct names; removing the
build cache does not remove browser sessions.

## Reuse beyond desktops

`environments.mkTools { packages = [ ... ]; }` creates a reusable tool closure
for a shell, container, sandbox or VM. `mkContainer` accepts an optional pinned
`fromImage`, `contents`, OCI `config`, persistent `volumes`, a descriptive `kind`
and optional Cua `port`. `mkCuaDesktop` composes those building blocks with the
upstream desktop, browser setup and keyring services. A desktop is a capability;
the runtime driver is independently recorded as `docker`.

Nix users can import `node_modules/@dispatch/runner/nix/environments` with their
own `pkgs`, or use `dispatch.lib.executionEnvironments { system = ...; }` from the
Dispatch flake. `build.nix` uses the pins shipped with the installed Runner.
Library upgrades are ordinary npm upgrades; application recipes need no separate
Dispatch revision. VM disk creation and cloud provisioning stay with NixOS and
Cua; Runner can attach their registered result. No VM launcher or cloud provisioner
is claimed by the bundled Docker driver.
