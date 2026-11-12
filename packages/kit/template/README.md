# Agents on the Dispatch kit

A starting point for a company's agent repository. The
[Dispatch kit](https://github.com/dispatchlabs-ai/dispatch/blob/main/packages/kit/README.md)
supplies the general roles; this repository holds what is yours.

| File | Holds |
| --- | --- |
| `flake.nix` | The Dispatch release this repository builds with, and the release's name |
| `factory.yaml` | The company's name and the agent a new conversation starts with |
| `AGENTS.md` | Guidance every agent receives |
| `agents/jett/company.md` | Instructions added to the kit's Jett |
| `kit.json` | What this repository changes in the kit: here, one model provider |

Build and list the agents. Nix reads only files Git knows, so add them first:

```sh
git init -q && git add -A
nix build
./result/bin/my-agents catalog
```

The kit's guide continues with
[a first conversation](https://github.com/dispatchlabs-ai/dispatch/blob/main/packages/kit/README.md#first-conversation),
adding your own agents, and upgrading.
