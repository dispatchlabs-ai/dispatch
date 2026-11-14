{ pkgs }:
{ name, packages ? [], files ? {}, description ? name, mainProgram ? null }:
let
  valid = path: path != "" && !(pkgs.lib.hasPrefix "/" path)
    && !(builtins.elem ".." (pkgs.lib.splitString "/" path));
in
assert builtins.all valid (builtins.attrNames files);
pkgs.buildEnv {
  inherit name;
  paths = packages ++ pkgs.lib.mapAttrsToList (path: text: pkgs.writeTextDir path text) files;
  pathsToLink = [ "/" ];
  meta = { inherit description; } // pkgs.lib.optionalAttrs (mainProgram != null) { inherit mainProgram; };
}
