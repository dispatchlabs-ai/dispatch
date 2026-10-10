{ lib, buildNpmPackage, nodejs_24, makeWrapper }:

buildNpmPackage {
  pname = "dispatch-web";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  nodejs = nodejs_24;
  nativeBuildInputs = [ makeWrapper ];

  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../package.json
      ../../../package-lock.json
      ../../../scripts
      ../package.json
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

  npmDepsHash = "sha256-4uIsx4wWYC66ZKzxfExDD3Bu+T9xLLbNPSRGYJEcr9Q=";
  npmBuildScript = "build";

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
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
    cp -R packages/web/build "$app/packages/web/"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-web" \
      --add-flags "$app/packages/web/build/service/server/index.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-auth" \
      --add-flags "$app/packages/web/build/service/server/auth-cli.js"
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
    cp -R packages/web/capabilities "$out/share/dispatch-web/capabilities"
    cp packages/web/server/storage/postgres/NOTICE "$out/share/dispatch-web/postgres-storage-NOTICE"
    mkdir -p "$out/share/dispatch-web/agent-browser"
    cp packages/web/server/skills/agent-browser/{LICENSE,NOTICE} "$out/share/dispatch-web/agent-browser/"
    ln -s "$app/packages/web/build/client" "$out/share/dispatch-web/client"
    runHook postInstall
  '';
}
