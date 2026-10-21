#!/bin/sh
# Dispatch for Apple Silicon macOS. Self-contained: bundled Node, no Nix or Homebrew.
set -eu
self=$(realpath "$0" 2>/dev/null || printf '%s\n' "$0")
root=$(cd "$(dirname "$self")/.." && pwd -P)
# Bundled official Node by default; DISPATCH_NODE overrides it with a compatible Node 24.
node="${DISPATCH_NODE:-$root/libexec/node/bin/node}"
server="$root/lib/dispatch-web/packages/web/build/service/server"
home="${DISPATCH_HOME:-$HOME/Library/Application Support/Dispatch}"
export DISPATCH_DATA_DIR="${DISPATCH_DATA_DIR:-$home/state}"
export DISPATCH_WORKSPACE_DIR="${DISPATCH_WORKSPACE_DIR:-$home/workspace}"
export DISPATCH_PORT="${DISPATCH_PORT:-3001}"
export DISPATCH_ORIGIN="${DISPATCH_ORIGIN:-http://localhost:$DISPATCH_PORT}"
export NODE_ENV="${NODE_ENV:-production}"

usage() {
  cat <<USAGE
Usage: dispatch [command]

  start                              Run Dispatch at \$DISPATCH_ORIGIN (default)
  invite --email EMAIL [--name NAME] Print a single-use enrollment link
  reset --email EMAIL --confirm-reset
                                     Replace an account's sign-in methods
  version                            Print the Dispatch version

State: $DISPATCH_DATA_DIR
Workspace: $DISPATCH_WORKSPACE_DIR
Stop Dispatch before running invite or reset.
USAGE
}

command="${1:-start}"
case "$command" in
  start)
    [ "$#" -gt 0 ] && shift
    umask 077
    mkdir -p "$DISPATCH_DATA_DIR" "$DISPATCH_WORKSPACE_DIR"
    exec "$node" "$server/index.js" "$@"
    ;;
  invite|reset)
    umask 077
    mkdir -p "$DISPATCH_DATA_DIR"
    exec "$node" "$server/auth-cli.js" "$@"
    ;;
  version|--version)
    exec "$node" -p 'require(process.argv[1]).version' "$root/lib/dispatch-web/packages/web/package.json"
    ;;
  help|-h|--help) usage ;;
  *) usage >&2; exit 2 ;;
esac
