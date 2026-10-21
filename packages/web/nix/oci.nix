{ lib, dockerTools, buildEnv, writeShellScript, bashInteractive, coreutils, findutils
, gnugrep, gnused, gawk, git, ripgrep, nodejs_24, cacert, web, sourceRevision
, disposableWorkspace ? false }:

let
  entrypoint = writeShellScript "dispatch-container" ''
    set -eu
    umask 077
    mkdir -p "$HOME" "$DISPATCH_DATA_DIR" "$DISPATCH_WORKSPACE_DIR"
    cd "$DISPATCH_WORKSPACE_DIR"
    exec "$@"
  '';
  runtime = buildEnv {
    name = "dispatch-container-runtime";
    paths = [ web bashInteractive coreutils findutils gnugrep gnused gawk git ripgrep nodejs_24 cacert ];
    pathsToLink = [ "/bin" "/etc/ssl/certs" ];
  };
in dockerTools.buildLayeredImage {
  name = if disposableWorkspace then "dispatch-workers" else "dispatch-web";
  tag = builtins.substring 0 12 sourceRevision;
  contents = [ runtime ];
  fakeRootCommands = ''
    mkdir -p ./data ./tmp
    chmod 0755 ./data
    chown 65532:65532 ./data
    chmod 1777 ./tmp
    ${lib.optionalString disposableWorkspace ''
      mkdir -p ./workspace
      chown 65532:65532 ./workspace
      chmod 0700 ./workspace
    ''}
  '';
  config = {
    User = "65532:65532";
    WorkingDir = "/data";
    Entrypoint = [ entrypoint ];
    Cmd = [ "${web}/bin/dispatch-web" ];
    Env = [
      "PATH=/bin"
      "HOME=/data/home"
      "NODE_ENV=production"
      "NODE_EXTRA_CA_CERTS=/etc/ssl/certs/ca-bundle.crt"
      "SSL_CERT_FILE=/etc/ssl/certs/ca-bundle.crt"
      "DISPATCH_HOST=0.0.0.0"
      "DISPATCH_PORT=3001"
      "DISPATCH_DATA_DIR=/data/state"
      "DISPATCH_WORKSPACE_DIR=/data/workspace"
    ];
    ExposedPorts."3001/tcp" = { };
    # Native OCI retains its existing read-only-root convention. Conversation workers
    # must not create anonymous volumes: their entire writable layer is disposable.
    # Stable services using this variant can supply explicit tmpfs mounts in Compose.
    Volumes = lib.optionalAttrs (!disposableWorkspace) { "/tmp" = { }; };
    Labels = {
      "org.opencontainers.image.title" = "Dispatch Web";
      "org.opencontainers.image.source" = "https://github.com/dispatchlabs-ai/dispatch";
      "org.opencontainers.image.revision" = sourceRevision;
      "org.opencontainers.image.version" = web.version;
    };
  };
  meta.platforms = lib.platforms.linux;
}
