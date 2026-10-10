{ runCommand, gnutar, gzip, coreutils, web }:

# Reuse the locked application build; customers consume this artifact, not source.
runCommand "dispatch-frontend" {
  nativeBuildInputs = [ gnutar gzip coreutils ];
} ''
  client=${web}/share/dispatch-web/client
  test -f "$client/index.html"
  mkdir -p "$out"
  # Normalize ordering, timestamps and ownership; gzip embeds no clock/filename.
  tar --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
    --mode='u=rwX,go=rX' -C "$client" -cf - . \
    | gzip -n > "$out/dispatch-frontend.tar.gz"
  cd "$out"
  sha256sum dispatch-frontend.tar.gz > SHA256SUMS
''
