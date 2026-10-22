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
          runtime = import ./packages/web/nix/runtime.nix { inherit pkgs; };
          web = pkgs.callPackage ./packages/web/nix/package.nix {
            inherit (runtime) nodejs_24;
          };
        in {
          packages = { default = web; frontend = pkgs.callPackage ./packages/web/nix/frontend.nix { inherit web; }; } // pkgs.lib.optionalAttrs (system == "aarch64-darwin") {
            macos-release = pkgs.callPackage ./packages/web/nix/macos-release.nix {
              inherit web;
              inherit (runtime) nodejs_24;
            };
          } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            oci = pkgs.callPackage ./packages/web/nix/oci.nix {
              inherit web;
              inherit (runtime) nodejs_24 git;
              sourceRevision = self.rev or self.dirtyRev or "uncommitted";
            };
            workers-oci = pkgs.callPackage ./packages/web/nix/oci.nix {
              inherit web;
              inherit (runtime) nodejs_24 git;
              sourceRevision = self.rev or self.dirtyRev or "uncommitted";
              disposableWorkspace = true;
            };
          };
          checks.web = web;
          devShells.default = pkgs.mkShell {
            packages = [ runtime.nodejs_24 ];
          };
        };
    in {
      packages = eachSystem (system: (forSystem system).packages);
      checks = eachSystem (system: (forSystem system).checks);
      devShells = eachSystem (system: (forSystem system).devShells);
    };
}
