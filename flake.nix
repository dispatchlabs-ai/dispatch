{
  description = "Dispatch local development and application build";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/aa48d347080940b8a2b8d2f48228674e280a3514";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      forSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };
          web = pkgs.callPackage ./packages/web/nix/package.nix { inherit (runtime) nodejs_24; };
          runtime = import ./packages/runner/nix/runtime.nix { inherit pkgs; };
          runner = pkgs.callPackage ./packages/runner/nix/package.nix { inherit (runtime) nodejs_24; };
          runner-slack = pkgs.callPackage ./packages/runner/nix/package.nix { inherit (runtime) nodejs_24; withSlack = true; };
          runner-google-chat = pkgs.callPackage ./packages/runner/nix/package.nix { inherit (runtime) nodejs_24; withGoogleChat = true; };
          runner-fleet = pkgs.callPackage ./packages/runner/nix/package.nix { inherit (runtime) nodejs_24; withSlack = true; withFleet = true; };
          claude-code-provider = pkgs.callPackage ./packages/runner/nix/claude-code-provider.nix { inherit (runtime) nodejs_24; inherit runner; };
          # Build the same complete definition files a reader sees in the example.
          agent-example = self.lib.mkAgentRelease {
            inherit system;
            name = "example-agents";
            src = ./examples/chat/definitions;
            revision = self.rev or self.dirtyRev or "uncommitted";
          };
          # Evaluation content is reusable and carries no installation identifiers.
          eval-content = pkgs.runCommand "dispatch-eval-content" { } ''
            ${runtime.nodejs_24}/bin/node ${./packages/eval}/scripts/check-content.mjs ${./packages/eval}
            touch $out
          '';
          eval-release = self.lib.mkAgentRelease {
            inherit system;
            name = "eval-example";
            src = ./examples/chat/definitions;
            revision = self.rev or self.dirtyRev or "uncommitted";
            withEval = true;
          };
        in {
          packages = { default = web; inherit agent-example runner runner-slack runner-fleet runner-google-chat claude-code-provider; frontend = pkgs.callPackage ./packages/web/nix/frontend.nix { inherit web; }; } // pkgs.lib.optionalAttrs (system == "aarch64-darwin") {
            macos-release = pkgs.callPackage ./packages/web/nix/macos-release.nix { inherit web; inherit (runtime) nodejs_24; };
          } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            oci = pkgs.callPackage ./packages/web/nix/oci.nix {
              inherit web;
              inherit (runtime) nodejs_24;
              sourceRevision = self.rev or self.dirtyRev or "uncommitted";
            };
            workers-oci = pkgs.callPackage ./packages/web/nix/oci.nix {
              inherit web;
              inherit (runtime) nodejs_24;
              sourceRevision = self.rev or self.dirtyRev or "uncommitted";
              disposableWorkspace = true;
            };
          } // pkgs.lib.optionalAttrs (system == "x86_64-linux") {
            workspace-cua = (import ./packages/runner/nix/workspace-tools.nix { inherit pkgs; }).cua;
            workspace-runsc = (import ./packages/runner/nix/workspace-tools.nix { inherit pkgs; }).runsc;
          };
          checks.web = web;
          checks.runner = runner;
          checks.runner-slack = runner-slack;
          checks.runner-fleet = runner-fleet;
          checks.runner-google-chat = runner-google-chat;
          checks.claude-code-provider = claude-code-provider;
          checks.agent-example = agent-example;
          checks.eval-content = eval-content;
          checks.eval-release = eval-release;
          devShells.default = pkgs.mkShell {
            packages = [ runtime.nodejs_24 pkgs.lsof ];
          };
        };
    in {
      lib.agentRuntime = { system }:
        import ./packages/runner/nix/runtime.nix { pkgs = import nixpkgs { inherit system; }; };
      lib.mkAgentRelease = { system, withSlack ? false, withFleet ? false, withGoogleChat ? false, execution ? null, ... }@args:
        let pkgs = import nixpkgs { inherit system; };
        in (pkgs.callPackage ./packages/runner/nix/release.nix {
          runtime = if execution != null then execution.package
            else pkgs.callPackage ./packages/runner/nix/package.nix {
              inherit ((import ./packages/runner/nix/runtime.nix { inherit pkgs; })) nodejs_24;
              inherit withFleet withGoogleChat; withSlack = withSlack || withFleet;
            };
          runtimeRevision = if execution != null then execution.revision else self.rev or self.dirtyRev or "uncommitted";
          watcher = (forSystem system).packages.runner;
          watcherRevision = self.rev or self.dirtyRev or "uncommitted";
          fleetTools = if withFleet then import ./packages/fleet/nix/tools.nix { inherit pkgs; } else null;
          eval = {
            src = pkgs.lib.fileset.toSource {
              root = ./packages/eval;
              fileset = pkgs.lib.fileset.unions [ ./packages/eval/src ./packages/eval/engine ./packages/eval/definitions ./packages/eval/example ./packages/eval/package.json ./packages/eval/LICENSE ];
            };
            revision = self.rev or self.dirtyRev or "uncommitted";
            version = (builtins.fromJSON (builtins.readFile ./packages/eval/package.json)).version;
            # The engine's locked dependencies on the same patched Python the release already carries.
            python = pkgs.callPackage ./packages/eval/nix/python.nix {
              inherit ((import ./packages/runner/nix/runtime.nix { inherit pkgs; })) python3;
            };
          };
        }) (builtins.removeAttrs args [ "system" "withSlack" "withFleet" "withGoogleChat" "execution" ]);
      packages = eachSystem (system: (forSystem system).packages);
      checks = eachSystem (system: (forSystem system).checks);
      devShells = eachSystem (system: (forSystem system).devShells);
    };
}
