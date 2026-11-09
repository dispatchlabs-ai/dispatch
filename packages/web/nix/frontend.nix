{ runCommand, gnutar, gzip, coreutils, web }:

# Reuse the locked application build; customers consume this artifact, not source.
runCommand "dispatch-frontend" {
  nativeBuildInputs = [ gnutar gzip coreutils ];
} ''
  client=${web}/share/dispatch-web/client
  test -f "$client/index.html"
  test ! -e "$client/LICENSE.txt"
  # Ship the MIT notice with the bundle. A .txt name serves as text/plain and is
  # not rewritten to index.html by the CDN's extensionless SPA fallback.
  bundle="$PWD/bundle"
  mkdir "$bundle"
  cp -R "$client/." "$bundle/"
  chmod -R u+w "$bundle"
  cp ${web}/share/dispatch-web/LICENSE "$bundle/LICENSE.txt"
  # The standalone frontend has no node_modules alongside it. Keep copied
  # component copyright/licenses plus Vite's bundled-dependency license report.
  cp -R ${web}/share/dispatch-web/licenses "$bundle/licenses"
  cp ${web}/share/dispatch-web/THIRD_PARTY.md "$bundle/THIRD_PARTY.md"
  test -s "$bundle/THIRD-PARTY-NOTICES.md"
  test -s "$bundle/licenses/Apache-2.0.txt"
  test -s "$bundle/licenses/ai-elements-NOTICE.txt"
  test -s "$bundle/licenses/shadcn-MIT.txt"
  mkdir -p "$out"
  # Normalize ordering, timestamps and ownership; gzip embeds no clock/filename.
  tar --sort=name --mtime=@1 --owner=0 --group=0 --numeric-owner \
    --mode='u=rwX,go=rX' -C "$bundle" -cf - . \
    | gzip -n > "$out/dispatch-frontend.tar.gz"
  cd "$out"
  sha256sum dispatch-frontend.tar.gz > SHA256SUMS
''
