#!/bin/sh
set -eu
root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
exec "$root/libexec/node/bin/node" "$root/lib/dispatch-web/packages/web/dist/server/server/main.js" "$@"
