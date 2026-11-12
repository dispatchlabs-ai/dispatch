{
  description = "Agents built on the Dispatch kit";

  # One tag selects the runtime, its Pi Durable and the kit. Move the tag to upgrade.
  inputs.dispatch.url = "github:dispatchlabs-ai/dispatch/v0.12.0";
  inputs.nixpkgs.follows = "dispatch/nixpkgs";

  outputs = { self, dispatch, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      # What the agents load. List new top-level files and folders here.
      source = nixpkgs.lib.fileset.toSource {
        root = ./.;
        fileset = nixpkgs.lib.fileset.unions [
          ./AGENTS.md ./factory.yaml ./kit.json ./agents
          (nixpkgs.lib.fileset.maybeMissing ./kit.lock.json)
          (nixpkgs.lib.fileset.maybeMissing ./skills)
          (nixpkgs.lib.fileset.maybeMissing ./src)
        ];
      };
    in {
      packages = nixpkgs.lib.genAttrs systems (system: {
        default = dispatch.lib.mkAgentRelease {
          inherit system;
          # Also the command's name: result/bin/my-agents.
          name = "my-agents";
          src = source;
          revision = self.rev or self.dirtyRev or "uncommitted";
          withKit = true;
        };
      });
    };
}
