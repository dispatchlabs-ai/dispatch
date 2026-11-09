{ lib, buildNpmPackage, nodejs_24, makeWrapper }:
buildNpmPackage {
  pname = "dispatch-web";
  version = (builtins.fromJSON (builtins.readFile ../package.json)).version;
  nodejs = nodejs_24;
  nativeBuildInputs = [ makeWrapper ];
  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../postgres/NOTICE ../../backend/AGENT-CHAT-LICENSE
      ../../../LICENSE ../../../package.json ../../../package-lock.json ../../../scripts
      ../../runner/AGENT-CHAT-LICENSE
      ../../runner/package.json ../../runner/tsconfig.json ../../runner/src ../../runner/native
      ../../remote/package.json ../../remote/tsconfig.json ../../remote/src
      ../../postgres/package.json ../../postgres/tsconfig.json ../../postgres/src
      ../../backend/package.json ../../backend/tsconfig.json ../../backend/src
      ../../workers/package.json ../../workers/tsconfig.json ../../workers/src
      ../../slack/package.json ../../slack/tsconfig.json ../../slack/src
      ../../google-chat/package.json ../../google-chat/tsconfig.json ../../google-chat/src
      ../../email/package.json ../../email/tsconfig.json ../../email/src
      ../../fleet/package.json ../../fleet/tsconfig.json ../../fleet/src
      ../../observer/package.json ../../observer/tsconfig.json ../../observer/src
      ../../fleet/scripts ../../observer/scripts ../../observer/licenses
      ../../observer/index.html ../../observer/vite.config.ts
      ../package.json ../tsconfig.json ../tsconfig.server.json ../vite.config.ts
      ../index.html ../src ../server ../openapi.yaml ../licenses ../LICENSE ../THIRD_PARTY.md
    ];
  };
  npmDepsHash = "sha256-YLW3zOBAdEC86SfPc78RWx9hsxqhGl2JSPye9rgjNuE=";
  ELECTRON_SKIP_BINARY_DOWNLOAD = "1";
  npmBuildScript = "build";
  doCheck = true;
  checkPhase = "npm run typecheck";
  installPhase = ''
    runHook preInstall
    npm prune --omit=dev --ignore-scripts
    app="$out/lib/dispatch-web"
    mkdir -p "$app/packages" "$out/bin" "$out/share/dispatch-web"
    cp package.json LICENSE "$app/"
    cp -R node_modules "$app/"
    for package in runner remote postgres backend workers slack google-chat email fleet observer web; do
      mkdir -p "$app/packages/$package"
      cp packages/$package/package.json "$app/packages/$package/"
      cp -R packages/$package/dist "$app/packages/$package/"
      if test -d packages/$package/node_modules; then cp -R packages/$package/node_modules "$app/packages/$package/"; fi
    done
    cp -R packages/runner/native "$app/packages/runner/"
    cp packages/runner/AGENT-CHAT-LICENSE "$app/packages/runner/"
    cp packages/web/openapi.yaml "$app/packages/web/"
    cp -R packages/web/licenses "$app/packages/web/"
    cp packages/web/LICENSE packages/web/THIRD_PARTY.md "$app/packages/web/"
    cp packages/web/THIRD_PARTY.md "$out/share/dispatch-web/THIRD_PARTY.md"
    cp LICENSE "$out/share/dispatch-web/LICENSE"
    cp packages/postgres/NOTICE "$out/share/dispatch-web/postgres-storage-NOTICE"
    cp packages/backend/AGENT-CHAT-LICENSE "$out/share/dispatch-web/AGENT-CHAT-LICENSE"
    cp -R packages/web/licenses "$out/share/dispatch-web/licenses"
    ln -s "$app/packages/web/dist/web" "$out/share/dispatch-web/client"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-web" --add-flags "$app/packages/web/dist/server/server/main.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-worker" --add-flags "$app/packages/workers/dist/main.js"
    makeWrapper ${nodejs_24}/bin/node "$out/bin/dispatch-bootstrap" --add-flags "$app/packages/web/dist/server/server/bootstrap.js"
    runHook postInstall
  '';
}
