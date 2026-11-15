{ recipe, system ? builtins.currentSystem }:
let
  # This pin ships with Runner, so its ordinary dependency upgrade also upgrades the builder.
  base = import (builtins.fetchTarball {
    url = "https://github.com/NixOS/nixpkgs/archive/aa48d347080940b8a2b8d2f48228674e280a3514.tar.gz";
    sha256 = "sha256-i8KuaINOYLvB2oQikGvtRmdZRxATRxsI9Yad2pp7dEA=";
  }) { inherit system; };
  pkgs = base // (import ../runtime.nix { pkgs = base; });
in import (builtins.toPath recipe) { inherit pkgs; environments = import ./default.nix { inherit pkgs; }; }
