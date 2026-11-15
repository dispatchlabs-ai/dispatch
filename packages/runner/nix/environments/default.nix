{ pkgs }:
let
  lib = pkgs.lib;
  mkTools = { name ? "environment-tools", packages ? [] }: pkgs.buildEnv {
    inherit name;
    paths = [ pkgs.bashInteractive pkgs.coreutils pkgs.curl pkgs.jq pkgs.ripgrep pkgs.cacert ] ++ packages;
    pathsToLink = [ "/bin" "/share" "/etc" ];
  };
  mkContainer = { name, kind ? "container", fromImage ? null, contents ? [], config ? {},
    volumes ? {}, port ? null, instructions ? "" }:
    let
      image = pkgs.dockerTools.buildLayeredImage {
        inherit name fromImage contents config;
      };
      manifest = pkgs.writeText "environment.json" (builtins.toJSON {
        version = 1;
        inherit name kind volumes port instructions;
        driver = "docker";
        image = "${image.imageName}:${image.imageTag}";
        platform = "linux/${if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "amd64"}";
      });
    in pkgs.runCommand "${name}-environment" { passthru = { inherit image; }; } ''
      mkdir -p "$out"
      ln -s ${manifest} "$out/environment.json"
      ln -s ${image} "$out/image.tar.gz"
    '';
  bitwarden = pkgs.runCommand "bitwarden-2026.10.2" {
    nativeBuildInputs = [ pkgs.unzip pkgs.python3 ];
    archive = pkgs.fetchurl {
      url = "https://github.com/bitwarden/clients/releases/download/browser-v2026.10.2/dist-chrome-2026.10.2.zip";
      sha256 = "2ebc61246a2ea82a65c589b8484e26a5678253fa6474c26dc5b6a7a7fcacbda4";
    };
  } ''
    mkdir -p "$out"
    unzip -q "$archive" -d "$out"
    python3 - "$out/manifest.json" ${./bitwarden-public-key.txt} <<'PY'
    import json, pathlib, sys
    path = pathlib.Path(sys.argv[1])
    manifest = json.loads(path.read_text())
    manifest['key'] = pathlib.Path(sys.argv[2]).read_text().strip()
    path.write_text(json.dumps(manifest))
    PY
  '';
  mkCuaDesktop = { name, packages ? [], chromiumPolicy ? {}, extensions ? [ bitwarden ],
    startUrl ? "about:blank", baseImage ? null }:
    let
      arch = if pkgs.stdenv.hostPlatform.isAarch64 then "arm64" else "amd64";
      base = if baseImage != null then baseImage else
        assert lib.assertMsg pkgs.stdenv.hostPlatform.isAarch64
          "The bundled Cua desktop image is ARM64. Supply a pinned baseImage for another Linux architecture, or attach an existing Cua Space.";
        pkgs.dockerTools.pullImage {
          imageName = "ghcr.io/trycua/linux";
          imageDigest = "sha256:4fd5ad4107d2d0e32c3363841836bce0773f2023c009a99d461358295233ef02";
          sha256 = "sha256-HsrjR8z2xcpXTb46Qrqz359DkO3bu8LKHeeBQkA/c5w=";
          os = "linux"; inherit arch;
        };
      spacesd = pkgs.fetchurl {
        url = "https://github.com/trycua/cua/releases/download/cua-spacesd-v0.13.0/cua-spacesd-${if arch == "arm64" then "aarch64" else "x86_64"}-unknown-linux-gnu";
        sha256 = if arch == "arm64" then "e35aa3da3f8341973e1973ba4a52bfb505efac1f892cacb6a0e34bd40790468b"
          else "8d40eb89ec8aa774834bda64f87c7e5b05f7d580440786e37d06291b841977df";
      };
      tools = mkTools { inherit packages; };
      browser = pkgs.writeShellScript "dispatch-browser" ''
        while [ ! -S /run/cua-desktop/bus ] || [ ! -S /tmp/.X11-unix/X1 ]; do sleep 0.1; done
        exec /usr/bin/chromium --no-first-run --no-default-browser-check \
          --user-data-dir=/home/cua/.config/chromium --password-store=gnome-libsecret \
          ${lib.optionalString (extensions != []) "--load-extension=${lib.concatStringsSep "," (map toString extensions)}"} \
          ${lib.escapeShellArg startUrl} "$@"
      '';
      keyring = pkgs.writeShellScript "dispatch-keyring" ''
        while [ ! -S /run/cua-desktop/bus ]; do sleep 0.1; done
        exec ${pkgs.gnome-keyring}/bin/gnome-keyring-daemon --foreground --components=secrets --control-directory=/run/cua-desktop/keyring
      '';
      supervisor = pkgs.writeText "environment-supervisor.conf" ''
        [program:dispatch-keyring]
        command=${keyring}
        user=cua
        environment=HOME="/home/cua",XDG_RUNTIME_DIR="/run/cua-desktop",DBUS_SESSION_BUS_ADDRESS="unix:path=/run/cua-desktop/bus"
        autorestart=true
        priority=35
        stdout_logfile=/var/log/supervisor/dispatch-keyring.log
        redirect_stderr=true

        [program:dispatch-browser]
        command=${browser}
        user=cua
        environment=HOME="/home/cua",DISPLAY=":1",XDG_RUNTIME_DIR="/run/cua-desktop",DBUS_SESSION_BUS_ADDRESS="unix:path=/run/cua-desktop/bus"
        autorestart=false
        priority=90
        stdout_logfile=/var/log/supervisor/dispatch-browser.log
        redirect_stderr=true
      '';
      root = pkgs.runCommand "${name}-root" {} ''
        mkdir -p "$out/opt/dispatch" "$out/usr/local/bin" "$out/opt/cua/entrypoint.d" "$out/etc/chromium/policies/managed"
        ln -s ${tools}/bin "$out/opt/dispatch/bin"
        install -m755 ${spacesd} "$out/usr/local/bin/cua-spacesd"
        ln -s ${browser} "$out/usr/local/bin/dispatch-browser"
        cp ${pkgs.writeText "policy.json" (builtins.toJSON chromiumPolicy)} "$out/etc/chromium/policies/managed/dispatch.json"
        cat > "$out/opt/cua/entrypoint.d/20-dispatch.sh" <<'SH'
        #!/bin/sh
        set -eu
        ${pkgs.python3}/bin/python3 ${./configure-desktop.py}
        if ! grep -q '^\[program:dispatch-keyring\]' /etc/supervisor/supervisord.conf; then
          cat ${supervisor} >> /etc/supervisor/supervisord.conf
        fi
        /opt/cua/bin/cua-image-manifest generate --image-json /etc/cua-image/image.json \
          --variant rootfs --arch ${arch} --spacesd-source release \
          --spacesd /usr/local/bin/cua-spacesd --out /etc/cua-image/manifest.json
        SH
        chmod +x "$out/opt/cua/entrypoint.d/20-dispatch.sh"
      '';
    in mkContainer {
      inherit name; kind = "desktop"; fromImage = base; contents = [ root ];
      port = 3211; volumes = { "/home/cua" = "home"; "/run/cua" = "token"; };
      instructions = "Persistent Chromium profile: /home/cua/.config/chromium. Downloads: ${chromiumPolicy.DownloadDirectory or "/home/cua/Downloads"}. Open dispatch-browser if the browser is closed. Bitwarden and the keyring may need unlocking after restart.";
      config = {
        Cmd = [ "/opt/cua/desktop/entrypoint.sh" ];
        WorkingDir = "/home/cua";
        Env = [
          "PATH=/opt/dispatch/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"
          "LANG=C.UTF-8" "LC_ALL=C.UTF-8" "TZ=Etc/UTC" "HOME=/root" "DISPLAY=:1"
          "CUA_X_SERVER=xvfb" "CUA_AUDIO=true" "CUA_ENV_AWAIT_TOKEN_FILE=0"
          "CUA_TELEMETRY=0" "DO_NOT_TRACK=1" "CUA_TELEMETRY_ENABLED=false"
          "CUA_TELEMETRY_DISABLED=1" "CUA_DRIVER_RS_TELEMETRY_ENABLED=false" "CUA_SPACESD_TELEMETRY=0"
        ];
        ExposedPorts."3211/tcp" = {};
        Healthcheck = { Test = [ "CMD" "/opt/cua/desktop/healthcheck.sh" ]; Interval = 10000000000;
          Timeout = 5000000000; StartPeriod = 30000000000; Retries = 12; };
      };
    };
in { inherit mkTools mkContainer mkCuaDesktop bitwarden; }
