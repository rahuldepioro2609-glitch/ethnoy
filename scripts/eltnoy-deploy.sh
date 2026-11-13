#!/bin/sh
# ELTNOY deployment wrapper (P1-D.3/P1-D.4). The ONLY approved way to run the host preflight and the
# deployment Compose operations. Usage:
#   scripts/eltnoy-deploy.sh --deployment-env-file /absolute/path/.env.production <operation> [--dry-run]
# Operations: preflight, build, start-postgres, migrate, start, status, stop,
#             emergency-status, emergency-stop (runbook §14.9).
# Invoke it by its canonical repository path; invocation through a symbolic link is refused.
#
# Start-up order (P4-3/P4-4): only shell built-ins run until PATH has been validated.
#   1. remove any imported shell functions that could shadow the built-ins used below, and refuse
#      to continue if the shell imported any exported function (bash as /bin/sh, BASH_FUNC_*);
#   2. refuse invocation through a symbolic link;
#   3. validate PATH (absolute entries only);
#   4. refuse Node/tsx runtime variables (NODE_*, except NODE_ENV, and TSX_*), read with `export -p`;
#   5. resolve node on the validated PATH and run it by absolute path.
# The Node entry repeats the environment checks (including BASH_FUNC_*) independently.
# Arguments are passed to Node unchanged and never evaluated by the shell.
# This is operator enforcement, not a security boundary (runbook §14.9); the host firewall (L-5)
# is still required.

# 1. bash (macOS /bin/sh) imports exported functions (BASH_FUNC_name%%) at start-up, and a function
#    can shadow a regular built-in or command. `export` is a POSIX special built-in, so in POSIX mode
#    (bash invoked as sh) it is found before any function: `export -pf` lists every imported
#    function reliably, and any is refused. dash (Ubuntu /bin/sh) imports no functions; the Node
#    entry refuses BASH_FUNC_* variables independently. Only `case`, `export`, `unset` and `exit`
#    (reserved words and special built-ins) run before this check completes.
case ${BASH_VERSION:-} in
  '') ;;
  *)
    imported_functions=$(export -pf)
    case $imported_functions in
      '') ;;
      *)
        unset -f printf
        printf 'eltnoy-deploy: refused: %s\n' 'exported shell functions (BASH_FUNC_*) are set in the environment; unset them.' >&2
        exit 2
        ;;
    esac
    ;;
esac
set -eu
set -f

refuse() {
  printf 'eltnoy-deploy: refused: %s\n' "$1" >&2
  exit 2
}

# 2. Canonical invocation only.
if [ -L "$0" ]; then
  refuse 'invoke scripts/eltnoy-deploy.sh by its repository path, not through a symbolic link.'
fi

# 3. PATH: absolute entries only (built-ins only).
search_path=${PATH:-}
case $search_path in
  '' | :* | *: | *::*) refuse 'PATH must contain only absolute directories (no empty entries).' ;;
esac
old_ifs=$IFS
IFS=:
for entry in $search_path; do
  case $entry in
    /*) ;;
    *) refuse 'PATH must contain only absolute directories (no "." or relative entries).' ;;
  esac
done
IFS=$old_ifs

# 4. Node/tsx runtime variables, from the shell's own list of exported variables (built-ins only).
#    A newline inside another variable's value can only cause a false refusal (fail closed).
exported=$(export -p)
runtime_overrides=''
IFS='
'
for line in $exported; do
  name=${line#export }
  name=${name#declare -x }
  name=${name%%=*}
  case $name in
    NODE_ENV) ;;
    NODE_* | TSX_*) runtime_overrides="$runtime_overrides $name" ;;
  esac
done
IFS=$old_ifs
if [ -n "$runtime_overrides" ]; then
  refuse "Node/tsx runtime variables are set (${runtime_overrides# }); unset them."
fi

# 5. node from the validated PATH, run by absolute path.
node_executable=$(command -v node || :)
case $node_executable in
  /*) ;;
  *) refuse 'node was not found on PATH as an absolute executable.' ;;
esac

case $0 in
  */*) script_directory=${0%/*} ;;
  *) script_directory=. ;;
esac
repository_root=$(CDPATH= cd -- "$script_directory/.." && pwd -P)
cd -- "$repository_root"
exec "$node_executable" --import tsx "$repository_root/server/deploy.ts" "$@"
