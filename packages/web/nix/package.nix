{ lib, buildNpmPackage, nodejs_24, makeWrapper }:

buildNpmPackage {
  pname = "dispatch-web";
  version = "0.1.0";
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
      ../src
      ../server
    ];
  };

  npmDepsHash = "sha256-uj9a3pAjoIFBKTpfKRp6UFU50P79n4Fmj8gJxgowv1A=";
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
    mkdir -p "$out/share/dispatch-web"
    ln -s "$app/packages/web/build/client" "$out/share/dispatch-web/client"
    runHook postInstall
  '';
}
