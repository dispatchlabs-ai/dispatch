{ runCommand, fetchurl, gnutar, gzip, coreutils, gnused, gnugrep, findutils, nodejs_24, web }:

# Portable Apple Silicon release: the locked application plus the official Node
# binary for the same version, relocatable and runnable without Nix or Homebrew.
let
  nodeVersion = nodejs_24.version;
  node = fetchurl {
    url = "https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-darwin-arm64.tar.gz";
    # From nodejs.org SHASUMS256.txt. A nixpkgs Node update must refresh this pin.
    sha256 = "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7";
  };
  name = "dispatch-${web.version}-darwin-arm64";
in runCommand name {
  nativeBuildInputs = [ gnutar gzip coreutils gnused gnugrep findutils ];
} ''
  root="$PWD/${name}"
  mkdir -p "$root/bin" "$root/lib" "$root/libexec/node/bin" node
  cp -R ${web}/lib/dispatch-web "$root/lib/dispatch-web"
  chmod -R u+w "$root"
  cp ${web}/share/dispatch-web/capabilities/../postgres-storage-NOTICE "$root/lib/dispatch-web/postgres-storage-NOTICE"
  tar -xzf ${node} -C node --strip-components=1
  install -m 0755 node/bin/node "$root/libexec/node/bin/node"
  cp node/LICENSE "$root/libexec/node/LICENSE"
  install -m 0755 ${./macos-dispatch.sh} "$root/bin/dispatch"
  cp "$root/lib/dispatch-web/LICENSE" "$root/LICENSE"

  # Package CLIs carry Nix-store shebangs; make them resolve the user's PATH instead.
  grep -rlI '^#! */nix/store/' "$root/lib" | while read -r file; do
    sed -i '1s|^#! */nix/store/[^/]*/bin/|#!/usr/bin/env |' "$file"
  done
  if grep -rl /nix/store "$root"; then echo "release still references /nix/store" >&2; exit 1; fi
  if find "$root" -type l -lname '/*' | grep .; then echo "absolute symlink in release" >&2; exit 1; fi

  mkdir -p "$out"
  tar --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
    --mode='u=rwX,go=rX' -C "$PWD" -cf - "${name}" | gzip -n > "$out/${name}.tar.gz"
  cd "$out"
  sha256sum "${name}.tar.gz" > SHA256SUMS
''
