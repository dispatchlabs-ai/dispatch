{
  description = "Dispatch local development and application build";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      forSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };
          web = pkgs.callPackage ./packages/web/nix/package.nix { };
          runner = pkgs.callPackage ./packages/runner/nix/package.nix { };
          runner-slack = pkgs.callPackage ./packages/runner/nix/package.nix { withSlack = true; };
        in {
          packages = { default = web; inherit runner runner-slack; frontend = pkgs.callPackage ./packages/web/nix/frontend.nix { inherit web; }; } // pkgs.lib.optionalAttrs (system == "aarch64-darwin") {
            macos-release = pkgs.callPackage ./packages/web/nix/macos-release.nix { inherit web; };
          } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            oci = pkgs.callPackage ./packages/web/nix/oci.nix {
              inherit web;
              sourceRevision = self.rev or self.dirtyRev or "uncommitted";
            };
            workers-oci = pkgs.callPackage ./packages/web/nix/oci.nix {
              inherit web;
              sourceRevision = self.rev or self.dirtyRev or "uncommitted";
              disposableWorkspace = true;
            };
          };
          checks.web = web;
          checks.runner = runner;
          checks.runner-slack = runner-slack;
          devShells.default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 ];
          };
        };
    in {
      lib.mkAgentRelease = { system, withSlack ? false, ... }@args:
        let pkgs = import nixpkgs { inherit system; };
        in (pkgs.callPackage ./packages/runner/nix/release.nix {
          runtime = pkgs.callPackage ./packages/runner/nix/package.nix { inherit withSlack; };
          runtimeRevision = self.rev or self.dirtyRev or "uncommitted";
        }) (builtins.removeAttrs args [ "system" "withSlack" ]);
      packages = eachSystem (system: (forSystem system).packages);
      checks = eachSystem (system: (forSystem system).checks);
      devShells = eachSystem (system: (forSystem system).devShells);
    };
}
