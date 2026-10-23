{ lib, buildNpmPackage, nodejs_24, makeWrapper }:

buildNpmPackage {
  pname = "dispatch-web";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  nodejs = nodejs_24;
  nativeBuildInputs = [ makeWrapper ];

  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../LICENSE
      ../../../package.json
      ../../../package-lock.json
      ../../../scripts
      ../../runner/package.json
      ../../runner/tsconfig.json
      ../../runner/src
      ../../remote/package.json
      ../../remote/tsconfig.json
      ../../remote/src
      ../../slack/package.json
      ../../slack/tsconfig.json
      ../../slack/src
      ../../observer/package.json
      ../../observer/tsconfig.json
      ../../observer/vite.config.ts
      ../../observer/index.html
      ../../observer/scripts
      ../../observer/src
      ../../observer/licenses
      ../package.json
      ../.storybook
      ../public
      ../react-router.config.ts
      ../vite.config.ts
      ../tsconfig.json
      ../tsconfig.server.json
      ../tsconfig.tooling.json
      ../tsconfig.capabilities.json
      ../capabilities/package.json
      ../capabilities/README.md
      ../src
      ../server
    ];
  };

  npmDepsHash = "sha256-EdQaAmN3r1Ho+GgcYyeJOgjhq10veh6ykja6Nt1B88M=";
  # The workspace compiles Observer here; its platform runtime is packaged separately.
  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  npmBuildScript = "build";

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
    npm run build:workshop
    # The workshop is checked here but is a local development surface.
    rm -r packages/web/build/workshop
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    app="$out/lib/dispatch-web"
    mkdir -p "$app/packages/web" "$out/bin"
    cp package.json "$app/"
    cp packages/web/package.json "$app/packages/web/"
    cp -R node_modules "$app/"
    if test -d packages/web/node_modules; then
      cp -R packages/web/node_modules "$app/packages/web/"
    fi
    for package in runner remote slack observer; do
      mkdir -p "$app/packages/$package"
      cp packages/$package/package.json "$app/packages/$package/"
      cp -R packages/$package/dist "$app/packages/$package/"
      if test -d packages/$package/node_modules; then
        cp -R packages/$package/node_modules "$app/packages/$package/"
      fi
    done
    # Compilation is complete; declarations and source maps are not runtime
    # inputs. Omitting them also reduces per-file metadata in lazy OCI images.
    find "$app/node_modules" -type f \
      \( -name '*.map' -o -name '*.d.ts' -o -name '*.d.mts' -o -name '*.d.cts' \) -delete
    cp -R packages/web/build "$app/packages/web/"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-web" \
      --add-flags "$app/packages/web/build/service/server/index.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-auth" \
      --add-flags "$app/packages/web/build/service/server/auth-cli.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-github-broker" \
      --add-flags "$app/packages/web/build/service/server/github/broker.js"
    test -f "$app/packages/web/build/service/server/workers/bootstrap-main.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-bootstrap" \
      --add-flags "$app/packages/web/build/service/server/workers/bootstrap-main.js"
    test -f "$app/packages/web/build/service/server/workers/database-init-main.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-database-init" \
      --add-flags "$app/packages/web/build/service/server/workers/database-init-main.js"
    test -f "$app/packages/web/build/service/server/workers/backend-main.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-backend" \
      --add-flags "$app/packages/web/build/service/server/workers/backend-main.js"
    test -f "$app/packages/web/build/service/server/workers/control-main.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-launcher" \
      --add-flags "$app/packages/web/build/service/server/workers/control-main.js"
    test -f "$app/packages/web/build/service/server/workers/worker-main.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-worker" \
      --add-flags "$app/packages/web/build/service/server/workers/worker-main.js"
    mkdir -p "$out/share/dispatch-web"
    cp LICENSE "$app/LICENSE"
    cp LICENSE "$out/share/dispatch-web/LICENSE"
    cp -R packages/web/capabilities "$out/share/dispatch-web/capabilities"
    cp packages/web/server/storage/postgres/NOTICE "$out/share/dispatch-web/postgres-storage-NOTICE"
    mkdir -p "$out/share/dispatch-web/agent-browser"
    cp packages/web/server/skills/agent-browser/{LICENSE,NOTICE} "$out/share/dispatch-web/agent-browser/"
    ln -s "$app/packages/web/build/client" "$out/share/dispatch-web/client"
    runHook postInstall
  '';
}
