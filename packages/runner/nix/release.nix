{ lib, runCommand, makeWrapper, runtime, runtimeRevision }:
{ name, src, revision, entrypoint ? null }:

assert builtins.match "[a-z][a-z0-9-]*" name != null;
runCommand "${name}-${lib.substring 0 12 revision}" {
  nativeBuildInputs = [ makeWrapper ];
  passthru = { inherit runtime; };
} ''
  app="$out/lib/${name}"
  mkdir -p "$app/definitions" "$out/bin" "$out/share/${name}"
  cp -R ${src}/. "$app/definitions/"
  ln -s ${runtime}/lib/agent-node_modules "$app/node_modules"
  echo '{"type":"module","private":true}' > "$app/package.json"
  ${if entrypoint == null then ''
    makeWrapper ${runtime}/bin/dispatch-agent "$out/bin/${name}" \
      --add-flags "--root $app/definitions"
  '' else ''
    test -f "$app/definitions/"${lib.escapeShellArg entrypoint}
    makeWrapper ${runtime.nodejs}/bin/node "$out/bin/${name}" \
      --add-flags "$app/definitions/"${lib.escapeShellArg entrypoint}
  ''}
  ${runtime}/bin/dispatch-agent --root "$app/definitions" catalog \
    > "$out/share/${name}/catalog.json"
  cat > "$out/share/${name}/release.json" <<'JSON'
  ${builtins.toJSON {
    schemaVersion = 1;
    inherit name revision;
    system = runtime.system;
    dispatch = { revision = runtimeRevision; version = runtime.version; storePath = toString runtime; };
    node = runtime.nodejs.version;
  }}
  JSON
''
