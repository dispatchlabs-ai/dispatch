{ pkgs }:
let
  workspace = import ../../runner/nix/workspace-tools.nix { inherit pkgs; };
  python = pkgs.python3.withPackages (ps: [ ps.boto3 ]);
in {
  python = "${python}/bin/python3";
  cua = "${workspace.cua}/bin/cua";
  runsc = "${workspace.runsc}/bin/runsc";
  caBundle = "${pkgs.cacert}/etc/ssl/certs/ca-bundle.crt";
  path = pkgs.lib.makeBinPath [ pkgs.bash pkgs.coreutils pkgs.openssh python ];
}
