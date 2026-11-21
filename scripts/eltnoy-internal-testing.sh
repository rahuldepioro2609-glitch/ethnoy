#!/bin/sh
# Isolated internal-testing deployment wrapper. Every Docker invocation is pinned to the dedicated
# Compose file, project, and operator env file. Run with Node 22+ and tsx dependencies installed.
set -eu
if [ -n "${NODE_OPTIONS:-}" ] || [ -n "${NODE_PATH:-}" ] || [ -n "${TSX_TSCONFIG_PATH:-}" ]; then
  printf '%s\n' 'internal-testing: refused: unset NODE_OPTIONS, NODE_PATH, and TSX_TSCONFIG_PATH before invoking the wrapper.' >&2
  exit 2
fi
case "$0" in
  */*) script_directory=${0%/*} ;;
  *) script_directory=. ;;
esac
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd -P)
cd -- "$repository_root"
exec node --import tsx "$repository_root/server/internalTestingDeploy.ts" "$@"
