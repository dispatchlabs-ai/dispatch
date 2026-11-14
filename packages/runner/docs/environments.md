# Repo-owned environments

An agent can select a runnable package from its application's locked Nix flake:

```ts
export default defineAgent({
  environment: {
    package: "browser",
    description: "Persistent browser environment; see environments/README.md.",
  },
});
```

The same `environment` object is accepted in `agent.md` frontmatter. It is optional.
The catalog and the agent's instructions expose the selection. Changing it changes
the definition fingerprint; existing conversations follow the host's ordinary
definition-update policy. Selection does not create compute, connect a desktop,
move the agent's native store, or redirect existing tools into a sandbox.

From the application checkout, use:

```sh
dispatch environment describe --agent helper
dispatch environment build --agent helper
dispatch environment run --agent helper -- --help
```

`describe` prints the selection and exact commands without invoking Nix. `build`
runs `nix build --no-update-lock-file --no-link --json`; `run` invokes `nix run`
and forwards arguments after `--` unchanged. Both require a committed lockfile,
use the Git-aware checkout reference, and leave lock updates explicit. Run these
commands only on trusted repositories: flake builds and launchers execute code.
The CLI passes `DISPATCH_AGENT_ID` to the launcher and preserves cancellation.
It does not open a conversation store or start an agent host.

## Share components and specialize agents

Keep common definitions under `environments/` and an agent's additions under
`agents/<id>/environment/`. Ordinary Nix imports and function arguments compose
them. A shared base is optional; unrelated operating systems can use independent
definitions. No custom inheritance language or generated instruction overlay is
needed. Package names are local flake output names, not machine addresses.

Dispatch's flake exports two small builders:

```nix
tools = dispatch.lib.mkEnvironment {
  inherit system;
  name = "research-tools";
  packages = [ pkgs.git pkgs.python3 ];
  files."etc/research/settings.json" = builtins.toJSON { output = "json"; };
};
```

`mkEnvironment` combines package paths and configuration files, rejecting file
collisions. An agent-specific definition can pass additional packages and files.
Set `mainProgram` when the result contains a launcher intended for `nix run`.
Software versions come from the application's locked inputs. Files in these
outputs are public build content: supply secret values and mutable state at runtime.

For a Docker-compatible image already produced by Nix:

```nix
packages.${system}.browser = dispatch.lib.mkContainerEnvironment {
  inherit system;
  name = "research-browser";
  image = browserImage; # e.g. pkgs.dockerTools.buildImage { ... }
  compose = {
    services.environment = {
      volumes = [ "home:/home/agent" ];
    };
    volumes.home = {};
  };
};
```

This builds a launcher with the locked Docker and Compose clients and a generated
Compose file containing the image's exact Nix-generated tag. Before `up`, `create`
or `run`, it loads the built archive when that image is absent. Remaining behavior
is ordinary Compose, including ports, volumes, private configuration bindings and
lifecycle. A compatible Docker engine must be available. `service` selects which
service receives the built image; it defaults to `environment`.

```sh
COMPOSE_PROJECT_NAME=research-helper dispatch environment run --agent helper -- up -d
COMPOSE_PROJECT_NAME=research-helper dispatch environment run --agent helper -- ps
COMPOSE_PROJECT_NAME=research-helper dispatch environment run --agent helper -- stop
```

Choose a stable project name per environment instance. The default is the package's
name plus `DISPATCH_AGENT_ID` (or `default` for direct `nix run`). Independent
projects have independent named volumes. Retain the same project and volumes for
the same agent's persistent browser state; rebuilding an image is separate from
replacing a running container. Compose deletion flags retain their usual effects.
The artifact's `share/dispatch/environment.json` records its image and Compose file.

Other environments can expose an ordinary Nix launcher for a VM, a headless
sandbox or a process environment. The agent selection and CLI are backend-neutral;
only the container convenience builder assumes Compose. A Nix development shell
provides tools but does not itself establish runtime isolation or a deployable image.
NixOS VM and other provider launchers remain application-owned integrations.

The image's target architecture and the launcher's host architecture are separate.
Build Linux artifacts on a matching Linux builder; a macOS development shell does
not make Linux executables runnable on macOS. Cua capabilities, authenticated
browser state and persistence must be qualified on the resulting environment.
