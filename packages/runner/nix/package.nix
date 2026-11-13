{ lib, stdenv, buildNpmPackage, nodejs_24, python3, makeWrapper, autoPatchelfHook, libxcb, lsof, withBackend ? false, withSlack ? false, withFleet ? false, withGoogleChat ? false }:

assert lib.assertMsg (lib.versions.major nodejs_24.version == "24" && lib.versionAtLeast nodejs_24.version "24.22.1")
  "Runner releases require patched Node 24.22.1+ within 24.x";
buildNpmPackage {
  pname = "dispatch-runner";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  nodejs = nodejs_24;
  nativeBuildInputs = [ makeWrapper ] ++ lib.optionals stdenv.hostPlatform.isLinux [ autoPatchelfHook ];
  buildInputs = lib.optionals stdenv.hostPlatform.isLinux [ stdenv.cc.cc.lib libxcb ];
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions ([
      ../AGENT-CHAT-LICENSE
      ../../../LICENSE
      ../../../package.json
      ../../../package-lock.json
      ../../postgres/package.json
      ../../backend/package.json
      ../../workers/package.json
      ../../web/package.json
      ../../remote/package.json
      ../../slack/package.json
      ../../google-chat/package.json
      ../../observer/package.json
      ../../email/package.json
      ../../fleet/package.json
      ../../eval/package.json
      ../package.json
      ../tsconfig.json
      ../src
      ../native
      ../scripts
    ] ++ lib.optionals withBackend [ ../../remote/src ../../remote/tsconfig.json ../../postgres/src ../../postgres/tsconfig.json ../../postgres/NOTICE ../../backend/src ../../backend/tsconfig.json ../../backend/AGENT-CHAT-LICENSE ]
      ++ lib.optionals withGoogleChat [ ../../google-chat/src ../../google-chat/tsconfig.json ]
      ++ lib.optionals withSlack [ ../../slack/src ../../slack/tsconfig.json ]
      ++ lib.optionals withFleet [ ../../fleet/src ../../fleet/scripts ../../fleet/tsconfig.json ]);
  };
  npmDepsHash = "sha256-75rQwUQfAJIAejdgZ9x38COV8MCeyXYLd+EYFxTyXTM=";
  npmInstallFlags = [ "--workspace=@dispatch/runner" "--include-workspace-root=false" ]
    ++ lib.optionals withBackend [ "--workspace=@dispatch/remote" "--workspace=@dispatch/postgres" "--workspace=@dispatch/backend" ]
    ++ lib.optional withGoogleChat "--workspace=@dispatch/google-chat"
    ++ lib.optional withSlack "--workspace=@dispatch/slack"
    ++ lib.optional withFleet "--workspace=@dispatch/fleet";
  npmWorkspace = "packages/runner";
  postBuild = lib.optionalString withBackend "npm run build --workspace=@dispatch/remote && npm run build --workspace=@dispatch/postgres && npm run build --workspace=@dispatch/backend\n"
    + lib.optionalString withGoogleChat "npm run build --workspace=@dispatch/google-chat\n"
    + lib.optionalString withSlack "npm run build --workspace=@dispatch/slack\n"
    + lib.optionalString withFleet "npm run build --workspace=@dispatch/fleet\n";
  installPhase = ''
    runHook preInstall
    npm prune --workspace=@dispatch/runner ${lib.optionalString withBackend "--workspace=@dispatch/remote --workspace=@dispatch/postgres --workspace=@dispatch/backend"} ${lib.optionalString withGoogleChat "--workspace=@dispatch/google-chat"} ${lib.optionalString withSlack "--workspace=@dispatch/slack"} ${lib.optionalString withFleet "--workspace=@dispatch/fleet"} --include-workspace-root=false --omit=dev --ignore-scripts
    app="$out/lib/dispatch-runner"
    mkdir -p "$app/packages/runner" "$out/bin"
    cp package.json package-lock.json LICENSE "$app/"
    cp packages/runner/AGENT-CHAT-LICENSE "$app/packages/runner/AGENT-CHAT-LICENSE"
    cp -R node_modules "$app/"
    cp packages/runner/package.json "$app/packages/runner/"
    cp -R packages/runner/{dist,native,scripts} "$app/packages/runner/"
    if test -d packages/runner/node_modules; then
      cp -R packages/runner/node_modules "$app/packages/runner/"
    fi
    ${lib.optionalString withBackend ''
      for component in remote postgres backend; do
        mkdir -p "$app/packages/$component"
        cp packages/$component/package.json "$app/packages/$component/"
        cp -R packages/$component/dist "$app/packages/$component/"
        if test -d packages/$component/node_modules; then cp -R packages/$component/node_modules "$app/packages/$component/"; fi
      done
      cp packages/backend/AGENT-CHAT-LICENSE "$app/packages/backend/"
      cp packages/postgres/NOTICE "$app/packages/postgres/"
    ''}
    ${lib.optionalString withSlack ''
      mkdir -p "$app/packages/slack"
      cp packages/slack/package.json "$app/packages/slack/"
      cp -R packages/slack/dist "$app/packages/slack/"
      if test -d packages/slack/node_modules; then cp -R packages/slack/node_modules "$app/packages/slack/"; fi
    ''}
    ${lib.optionalString withGoogleChat ''
      mkdir -p "$app/packages/google-chat"
      cp packages/google-chat/package.json "$app/packages/google-chat/"
      cp -R packages/google-chat/dist "$app/packages/google-chat/"
      if test -d packages/google-chat/node_modules; then cp -R packages/google-chat/node_modules "$app/packages/google-chat/"; fi
    ''}
    ${lib.optionalString withFleet ''
      mkdir -p "$app/packages/fleet"
      cp packages/fleet/package.json "$app/packages/fleet/"
      cp -R packages/fleet/{dist,scripts} "$app/packages/fleet/"
      if test -d packages/fleet/node_modules; then cp -R packages/fleet/node_modules "$app/packages/fleet/"; fi
    ''}
    # Workspace locks can nest a direct dependency (for example yaml). Expose
    # Runner's exact direct packages to definitions without changing its tree.
    node --input-type=module - "$app" "$out/lib/agent-node_modules" <<'JS'
    import { existsSync, mkdirSync, readFileSync, symlinkSync } from "node:fs";
    import { dirname, join } from "node:path";
    const [app, modules] = process.argv.slice(2);
    for (const component of ["runner"${lib.optionalString withBackend '', "remote", "postgres", "backend"''}${lib.optionalString withGoogleChat '', "google-chat"''}${lib.optionalString withSlack '', "slack"''}${lib.optionalString withFleet '', "fleet"''}]) {
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
      --add-flags "$app/packages/runner/dist/agent-cli.js" --prefix PATH : ${lib.makeBinPath [ lsof ]}
    ln -s dispatch-agent "$out/bin/dispatch"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-service" \
      --add-flags "$app/packages/runner/dist/service-cli.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-native-tools" \
      --add-flags "$app/packages/runner/dist/native-tools-cli.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-watch" \
      --add-flags "$app/packages/runner/dist/watch-cli.js" --prefix PATH : ${lib.makeBinPath [ lsof ]}
    runHook postInstall
  '';
  passthru = { nodejs = nodejs_24; inherit python3; };
}
