{ lib, stdenv, buildNpmPackage, nodejs_24, makeWrapper, autoPatchelfHook }:

buildNpmPackage {
  pname = "dispatch-runner";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  nodejs = nodejs_24;
  nativeBuildInputs = [ makeWrapper ] ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../LICENSE
      ../../../package.json
      ../../../package-lock.json
      ../../web/package.json
      ../../remote/package.json
      ../../slack/package.json
      ../../observer/package.json
      ../../email/package.json
      ../package.json
      ../tsconfig.json
      ../src
      ../native
    ];
  };
  npmDepsHash = "sha256-SDsGv0ChsOoXTzhcdMgbcw8U0XL78GqBmrDCAWA6R1A=";
  npmInstallFlags = [ "--workspace=@dispatch/runner" "--include-workspace-root=false" ];
  npmWorkspace = "packages/runner";
  installPhase = ''
    runHook preInstall
    npm prune --workspace=@dispatch/runner --include-workspace-root=false --omit=dev --ignore-scripts
    app="$out/lib/dispatch-runner"
    mkdir -p "$app/packages/runner" "$out/bin"
    cp package.json package-lock.json LICENSE "$app/"
    cp -R node_modules "$app/"
    cp packages/runner/package.json "$app/packages/runner/"
    cp -R packages/runner/{dist,native} "$app/packages/runner/"
    if test -d packages/runner/node_modules; then
      cp -R packages/runner/node_modules "$app/packages/runner/"
    fi
    # Workspace locks can nest a direct dependency (for example yaml). Expose
    # Runner's exact direct packages to definitions without changing its tree.
    node --input-type=module - "$app" "$out/lib/agent-node_modules" <<'JS'
    import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
    import { dirname, join } from "node:path";
    const [app, modules] = process.argv.slice(2);
    const runner = join(app, "packages/runner");
    const manifest = JSON.parse(readFileSync(join(runner, "package.json"), "utf8"));
    for (const name of ["@dispatch/runner", ...Object.keys(manifest.dependencies), ...Object.keys(manifest.optionalDependencies)]) {
      const source = name === "@dispatch/runner" ? runner
        : [join(runner, "node_modules", name), join(app, "node_modules", name)].find(existsSync);
      if (!source && name in manifest.optionalDependencies) continue;
      if (!source) throw new Error(`Missing runtime dependency: ''${name}`);
      const target = join(modules, name);
      mkdirSync(dirname(target), { recursive: true });
      symlinkSync(source, target);
    }
    JS
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-agent" \
      --add-flags "$app/packages/runner/dist/agent-cli.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-service" \
      --add-flags "$app/packages/runner/dist/service-cli.js"
    runHook postInstall
  '';
  passthru.nodejs = nodejs_24;
}
