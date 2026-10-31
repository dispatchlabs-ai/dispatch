{ pkgs }:
assert pkgs.stdenv.hostPlatform.system == "x86_64-linux";
{
  cua = pkgs.stdenvNoCC.mkDerivation {
    pname = "dispatch-workspace-cua";
    version = "0.5.0";
    src = pkgs.fetchurl {
      url = "https://github.com/trycua/cua/releases/download/cua-sdk-v0.5.0/cua-cli-0.5.0-linux-x64.tar.gz";
      sha256 = "6a7bf715662106fa397c241346e7ac2047f05d8306ab00f988e4153720001306";
    };
    sourceRoot = ".";
    dontBuild = true;
    dontStrip = true;
    installPhase = ''
      install -Dm755 cua "$out/bin/cua"
    '';
    meta = {
      description = "Pinned Cua controller for disposable workflow workspaces";
      homepage = "https://github.com/trycua/cua";
      platforms = [ "x86_64-linux" ];
    };
  };
  runsc = pkgs.stdenvNoCC.mkDerivation {
    pname = "dispatch-workspace-runsc";
    version = "20261026.0";
    src = pkgs.fetchurl {
      url = "https://storage.googleapis.com/gvisor/releases/release/20261026.0/x86_64/gvisor.tar.bz2";
      sha256 = "096589d2d6078ba4caa26aa0200932f571aa5da9d08a5156b98ab1d93fa54468";
    };
    sourceRoot = ".";
    dontBuild = true;
    dontStrip = true;
    installPhase = ''
      mkdir -p "$out/bin"
      cp -R runsc containerd-shim-runsc-v1 gvisor-bin "$out/bin/"
    '';
    meta = {
      description = "Pinned gVisor runtime and helpers for disposable workflow workspaces";
      homepage = "https://gvisor.dev/";
      license = pkgs.lib.licenses.asl20;
      platforms = [ "x86_64-linux" ];
    };
  };
}
