{ lib, buildNpmPackage, nodejs_24 }:

buildNpmPackage {
  pname = "dispatch-web";
  version = "0.0.0";
  nodejs = nodejs_24;

  src = lib.fileset.toSource {
    root = ../../..;
    fileset = lib.fileset.unions [
      ../../../package.json
      ../../../package-lock.json
      ../package.json
      ../react-router.config.ts
      ../vite.config.ts
      ../tsconfig.json
      ../src
    ];
  };

  npmDepsHash = "sha256-VhRSrP35nuPgVeKwMLgWCHbAttn8w00kxuLSMAS2C3c=";
  npmBuildScript = "build";

  doCheck = true;
  checkPhase = ''
    runHook preCheck
    npm run typecheck
    runHook postCheck
  '';

  installPhase = ''
    runHook preInstall
    mkdir -p "$out/share/dispatch-web"
    cp -R packages/web/build/client/. "$out/share/dispatch-web/"
    runHook postInstall
  '';
}
