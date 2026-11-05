{ pkgs }:
let
  workspace = import ../../runner/nix/workspace-tools.nix { inherit pkgs; };
  pythonRuntime = pkgs.python3.withPackages (ps: [ ps.boto3 ]);
  python = pkgs.writeShellScriptBin "python3" ''
    export PYTHONDONTWRITEBYTECODE=1
    exec ${pythonRuntime}/bin/python3 -B "$@"
  '';
in {
  python = "${python}/bin/python3";
  cua = "${workspace.cua}/bin/cua";
  runsc = "${workspace.runsc}/bin/runsc";
  caBundle = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  path = pkgs.lib.makeBinPath [ pkgs.bash pkgs.coreutils pkgs.openssh python ];
}
