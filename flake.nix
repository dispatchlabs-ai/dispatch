{
  description = "Dispatch Web local development and application build";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-26.05";

  outputs = { self, nixpkgs }:
    let
      systems = [ "aarch64-darwin" "aarch64-linux" "x86_64-linux" ];
      eachSystem = nixpkgs.lib.genAttrs systems;
      forSystem = system:
        let
          pkgs = import nixpkgs { inherit system; };
          web = pkgs.callPackage ./packages/web/nix/package.nix { };
        in {
          packages = { default = web; } // pkgs.lib.optionalAttrs pkgs.stdenv.hostPlatform.isLinux {
            oci = pkgs.callPackage ./packages/web/nix/oci.nix {
              inherit web;
              sourceRevision = self.rev or self.dirtyRev or "uncommitted";
            };
          };
          checks.web = web;
          devShells.default = pkgs.mkShell {
            packages = [ pkgs.nodejs_24 ];
          };
        };
    in {
      packages = eachSystem (system: (forSystem system).packages);
      checks = eachSystem (system: (forSystem system).checks);
      devShells = eachSystem (system: (forSystem system).devShells);
    };
}
