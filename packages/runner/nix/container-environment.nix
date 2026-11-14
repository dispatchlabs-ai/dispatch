{ pkgs }:
{ name, image, compose, service ? "environment", description ? name }:
let
  reference = "${image.imageName}:${image.imageTag}";
  config = pkgs.writeText "${name}-compose.json" (builtins.toJSON (compose // {
    services = compose.services // {
      ${service} = compose.services.${service} // { image = reference; };
    };
  }));
  launcher = pkgs.writeShellApplication {
    inherit name;
    runtimeInputs = [ pkgs.docker-client pkgs.docker-compose ];
    text = ''
      export COMPOSE_PROJECT_NAME="''${COMPOSE_PROJECT_NAME:-${name}-''${DISPATCH_AGENT_ID:-default}}"
      for argument in "$@"; do
        case "$argument" in
          up|create|run)
            if ! docker image inspect ${pkgs.lib.escapeShellArg reference} >/dev/null 2>&1; then
              docker load --input ${image}
            fi
            break ;;
        esac
      done
      exec docker-compose -f ${config} "$@"
    '';
  };
in
(import ./environment.nix { inherit pkgs; }) {
  inherit name description;
  mainProgram = name;
  packages = [ launcher ];
  files."share/dispatch/environment.json" = builtins.toJSON {
    schemaVersion = 1;
    inherit name description;
    kind = "container";
    image = reference;
    imageArchive = toString image;
    compose = toString config;
  };
}
