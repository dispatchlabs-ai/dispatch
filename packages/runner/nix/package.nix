{ lib, stdenv, buildNpmPackage, nodejs_24, makeWrapper, autoPatchelfHook, withSlack ? false }:

buildNpmPackage {
  pname = "dispatch-runner";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  nodejs = nodejs_24;
  nativeBuildInputs = [ makeWrapper ] ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib ];
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions ([
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
    ] ++ lib.optionals withSlack [ ../../slack/src ../../slack/tsconfig.json ]);
  };
  npmDepsHash = "sha256-SDsGv0ChsOoXTzhcdMgbcw8U0XL78GqBmrDCAWA6R1A=";
  npmInstallFlags = [ "--workspace=@dispatch/runner" "--include-workspace-root=false" ]
    ++ lib.optional withSlack "--workspace=@dispatch/slack";
  npmWorkspace = "packages/runner";
  postBuild = lib.optionalString withSlack "npm run build --workspace=@dispatch/slack";
  installPhase = ''
    runHook preInstall
    npm prune --workspace=@dispatch/runner ${lib.optionalString withSlack "--workspace=@dispatch/slack"} --include-workspace-root=false --omit=dev --ignore-scripts
    app="$out/lib/dispatch-runner"
    mkdir -p "$app/packages/runner" "$out/bin"
    cp package.json package-lock.json LICENSE "$app/"
    cp -R node_modules "$app/"
    cp packages/runner/package.json "$app/packages/runner/"
    cp -R packages/runner/{dist,native} "$app/packages/runner/"
    if test -d packages/runner/node_modules; then
      cp -R packages/runner/node_modules "$app/packages/runner/"
    fi
    ${lib.optionalString withSlack ''
      mkdir -p "$app/packages/slack"
      cp packages/slack/package.json "$app/packages/slack/"
      cp -R packages/slack/dist "$app/packages/slack/"
      if test -d packages/slack/node_modules; then cp -R packages/slack/node_modules "$app/packages/slack/"; fi
    ''}
    # Workspace locks can nest a direct dependency (for example yaml). Expose
    # Runner's exact direct packages to definitions without changing its tree.
    node --input-type=module - "$app" "$out/lib/agent-node_modules" <<'JS'
    import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
    import { dirname, join } from "node:path";
    const [app, modules] = process.argv.slice(2);
    for (const component of ["runner"${lib.optionalString withSlack '', "slack"''}]) {
    const directory = join(app, "packages", component);
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
    for (const name of [manifest.name, ...Object.keys(manifest.dependencies), ...Object.keys(manifest.optionalDependencies ?? {})]) {
      const source = name === manifest.name ? directory
        : [join(directory, "node_modules", name), join(app, "node_modules", name)].find(existsSync);
      if (!source && name in (manifest.optionalDependencies ?? {})) continue;
      if (!source) throw new Error(`Missing runtime dependency: ''${name}`);
      const target = join(modules, name);
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target)) symlinkSync(source, target);
    }
    }
    JS
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-agent" \
      --add-flags "$app/packages/runner/dist/agent-cli.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-service" \
      --add-flags "$app/packages/runner/dist/service-cli.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-native-tools" \
      --add-flags "$app/packages/runner/dist/native-tools-cli.js"
    runHook postInstall
  '';
  passthru.nodejs = nodejs_24;
}
