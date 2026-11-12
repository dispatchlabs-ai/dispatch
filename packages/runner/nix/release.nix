{ lib, runCommand, makeWrapper, runtimeShell, runtime, runtimeRevision, watcher, watcherRevision, fleetTools ? null, kit ? null }:
{ name, src, revision, entrypoint ? null, nodeModules ? null, workspace ? null, fleet ? null, withKit ? false }:

assert builtins.match "[a-z][a-z0-9-]*" name != null;
assert fleet == null || (fleetTools != null && workspace != null && fleet.roles != []
  && builtins.match "[a-z][a-z0-9-]*" fleet.namespace != null
  && builtins.match "[a-zA-Z0-9_./-]+" fleet.module != null
  && !(lib.hasPrefix "/" fleet.module) && !(builtins.elem ".." (lib.splitString "/" fleet.module))
  && builtins.all (role: builtins.match "[a-z][a-z0-9_-]*" role != null) fleet.roles);
assert lib.assertMsg (!withKit || kit != null) "withKit needs the kit that dispatch.lib.mkAgentRelease supplies.";
runCommand "${name}-${lib.substring 0 12 revision}" {
  nativeBuildInputs = [ makeWrapper ];
  passthru = { inherit runtime watcher; };
} ''
  app="$out/lib/${name}"
  mkdir -p "$app/definitions" "$out/bin" "$out/share/${name}"
  ${if withKit then ''
    ${runtime.nodejs}/bin/node ${kit.src}/scripts/compose.mjs ${kit.src} ${src} "$app/definitions" "$out/share/${name}/kit.json"
  '' else ''cp -R ${src}/. "$app/definitions/"''}
  ${lib.optionalString (nodeModules != null) ''ln -s ${nodeModules} "$app/definitions/node_modules"''}
  ln -s ${runtime}/lib/agent-node_modules "$app/node_modules"
  echo '{"type":"module","private":true}' > "$app/package.json"
  ${if entrypoint == null then ''
    makeWrapper ${runtime}/bin/dispatch-agent "$out/bin/.${name}-run" \
      --add-flags "--root $app/definitions --release-manifest $out/share/${name}/release.json"
    cat > "$out/bin/${name}" <<'SH'
    #!${runtimeShell}
    if [ "''${1:-}" = watch ]; then
      shift
      exec ${watcher}/bin/dispatch-watch "$@"
    fi
    if [ "''${1:-}" = --help ]; then
      @EXECUTION@ "$@"
      echo
      echo '${name} watch --config HOST.json [--session KEY] [--json]'
      exit
    fi
    exec @EXECUTION@ "$@"
    SH
    substituteInPlace "$out/bin/${name}" --replace-fail '@EXECUTION@' "$out/bin/.${name}-run"
    chmod +x "$out/bin/${name}"
  '' else ''
    test -f "$app/definitions/"${lib.escapeShellArg entrypoint}
    makeWrapper ${runtime.nodejs}/bin/node "$out/bin/${name}" \
      --add-flags "$app/definitions/"${lib.escapeShellArg entrypoint}
  ''}
  ${runtime}/bin/dispatch-agent --root "$app/definitions" catalog \
    > "$out/share/${name}/catalog.json"
  cat > "$out/share/${name}/release.json" <<'JSON'
  ${builtins.toJSON ({
    schemaVersion = 1;
    inherit name revision;
    system = runtime.system;
    dispatch = { revision = runtimeRevision; version = runtime.version; storePath = toString runtime; };
    watch = { revision = watcherRevision; storePath = toString watcher; command = "${watcher}/bin/dispatch-watch"; };
    node = runtime.nodejs.version;
    python = "${runtime.python3}/bin/python3";
    workspaceController = "${runtime}/lib/dispatch-runner/packages/runner/scripts/workspace.py";
    runtimeEntryPoint = { node = "${runtime.nodejs}/bin/node"; module = "${runtime}/lib/dispatch-runner/packages/runner/dist/agent-cli.js"; };
    inherit workspace;
    fleet = if fleet == null then null else fleet // {
      format = 1;
      tools = fleetTools // {
        node = "${runtime.nodejs}/bin/node";
        host = "${runtime}/lib/dispatch-runner/packages/fleet/dist/host.js";
        storage = "${runtime}/lib/dispatch-runner/packages/fleet/dist/storage-server.js";
        scripts = "${runtime}/lib/dispatch-runner/packages/fleet/scripts";
      };
    };
  } // lib.optionalAttrs withKit { kit = { inherit (kit) revision version; }; })}
  JSON
  ${runtime.nodejs}/bin/node --input-type=module - "$out/share/${name}/release.json" "$app/definitions" <<'JS'
  import { readFileSync, writeFileSync } from "node:fs";
  const [path, definitionsRoot] = process.argv.slice(2);
  const release = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(path, JSON.stringify({ ...release, definitionsRoot }) + "\n");
  JS
''
