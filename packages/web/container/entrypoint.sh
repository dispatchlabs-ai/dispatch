#!/bin/sh
set -eu
umask 077
mkdir -p "$HOME" "$DISPATCH_DATA_DIR" "$DISPATCH_WORKSPACE_DIR"
cd "$DISPATCH_WORKSPACE_DIR"
exec "$@"
