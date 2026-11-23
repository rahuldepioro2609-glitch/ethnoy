#!/usr/bin/env bash
# ELTNOY AUTH C1.4-B-3.2 — disposable PostgreSQL runner for server/databaseGrants.postgres.integration.test.ts.
#
# Creates a brand-new, loopback-only PostgreSQL cluster in a fresh directory, runs ONLY the grants
# integration test file against its single disposable database, then stops and deletes exactly that
# cluster. It never uses Docker, never reads .env or .env.production, never touches any other
# PostgreSQL server, and never prints a password or a connection string with a password.
#
# Usage (an explicit, approved scratch directory is REQUIRED; nothing is defaulted):
#   scripts/run-disposable-grants-tests.sh --scratch-dir /absolute/approved/scratch
#
# Exit status: the test run's status; 2 for a refused precondition; 3 if cleanup could not be verified
# (the cluster directory is then PRESERVED and its path and process id are reported).
#
# Cleanup runs on EXIT, INT and TERM. It cannot run on SIGKILL: see the runbook ("Disposable
# PostgreSQL runner", SIGKILL recovery).
set -euo pipefail
umask 077

refuse() { printf 'REFUSED: %s\n' "$1" >&2; exit 2; }
note() { printf '%s\n' "$1"; }

# --- arguments -----------------------------------------------------------------------------------
scratch=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    --scratch-dir) [ "$#" -ge 2 ] || refuse '--scratch-dir needs a value.'; scratch=$2; shift 2 ;;
    *) refuse "unknown argument (only --scratch-dir is accepted)." ;;
  esac
done
[ -n "$scratch" ] || refuse '--scratch-dir /absolute/approved/path is required (no default).'
case "$scratch" in /*) ;; *) refuse '--scratch-dir must be an absolute path.' ;; esac
[ -d "$scratch" ] && [ ! -L "$scratch" ] || refuse '--scratch-dir must be an existing real directory.'
[ "$(stat -f %u "$scratch" 2>/dev/null || stat -c %u "$scratch")" = "$(id -u)" ] || refuse '--scratch-dir must be owned by the current user.'
scratch=$(cd -- "$scratch" && pwd -P)

# --- repository and tools ------------------------------------------------------------------------
script_directory=$(cd -- "$(dirname -- "$0")" && pwd -P)
repository_root=$(cd -- "$script_directory/.." && pwd -P)
test_file="$repository_root/server/databaseGrants.postgres.integration.test.ts"
[ -f "$test_file" ] || refuse 'the integration test file was not found.'
for tool in initdb pg_ctl psql postgres lsof openssl node; do
  command -v "$tool" >/dev/null 2>&1 || refuse "$tool was not found on PATH."
done
node_executable=$(command -v node)
pg_bin=$(dirname -- "$(command -v pg_ctl)")
note "PostgreSQL binaries: $pg_bin ($("$pg_bin/postgres" --version))"

# --- snapshot of the existing default server (never touched; verified unchanged at the end) ----------
existing_snapshot() {
  lsof -nP -iTCP:5432 -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | sort -u | while read -r pid; do
    printf '%s %s\n' "$pid" "$(ps -o lstart= -p "$pid" 2>/dev/null | tr -s ' ')"
  done
}
existing_before=$(existing_snapshot)
note "Existing port-5432 listeners recorded: $(printf '%s' "$existing_before" | awk '{print $1}' | tr '\n' ' ')"

run_directory=''
data_directory=''
cluster_pid=''
port=''

# --- cleanup (EXIT, INT, TERM) -----------------------------------------------------------------
cleanup_done=0
cleanup() {
  local status=$?
  [ "$cleanup_done" = 0 ] || return 0
  cleanup_done=1
  set +e
  local verified=1
  if [ -f "$data_directory/postmaster.pid" ]; then
    cluster_pid=$(head -n 1 "$data_directory/postmaster.pid")
    LC_ALL=en_US.UTF-8 "$pg_bin/pg_ctl" -D "$data_directory" -m fast -w -t 30 stop >/dev/null 2>&1
  fi
  if [ -n "$cluster_pid" ] && kill -0 "$cluster_pid" 2>/dev/null; then verified=0; fi
  if [ -n "$port" ] && lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then verified=0; fi
  if [ -z "$run_directory" ]; then
    :
  elif [ "$verified" = 1 ]; then
    case "$run_directory" in
      "$scratch"/pg-grants-????????) rm -rf -- "$run_directory" && note "Cleanup: cluster stopped, port $port free, directory removed." ;;
      *) note "Cleanup: directory name unexpected; NOT removed: $run_directory"; status=3 ;;
    esac
  else
    note "Cleanup NOT verified: the directory is PRESERVED: $run_directory (process id: ${cluster_pid:-unknown}, port: ${port:-unknown})."
    status=3
  fi
  local existing_after
  existing_after=$(existing_snapshot)
  if [ "$existing_after" = "$existing_before" ]; then note 'Existing port-5432 listeners unchanged.'; else note 'WARNING: the existing port-5432 listeners changed during the run.'; status=3; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# --- fresh directory and port --------------------------------------------------------------------
run_directory=$(mktemp -d "$scratch/pg-grants-XXXXXXXX")
case "$run_directory" in "$scratch"/pg-grants-????????) ;; *) bad=$run_directory; run_directory=''; refuse "unexpected temporary directory name ($bad left in place)." ;; esac
[ -z "$(ls -A "$run_directory")" ] || refuse 'the temporary directory is not empty.'
data_directory="$run_directory/data"
for _ in $(seq 1 50); do
  candidate=$(( 20000 + RANDOM % 40000 ))
  if [ "$candidate" != 5432 ] && ! lsof -nP -iTCP:"$candidate" >/dev/null 2>&1; then port=$candidate; break; fi
done
[ -n "$port" ] || refuse 'no free port was found.'

# --- credentials (test-only, 0600, never printed) -------------------------------------------------
password_file="$run_directory/password"
pgpass_file="$run_directory/pgpass"
openssl rand -hex 24 > "$password_file"
chmod 600 "$password_file"
printf '127.0.0.1:%s:*:it_super:%s\n' "$port" "$(cat "$password_file")" > "$pgpass_file"
chmod 600 "$pgpass_file"

# --- cluster -------------------------------------------------------------------------------------
"$pg_bin/initdb" -D "$data_directory" -U it_super --pwfile="$password_file" \
  --auth-local=scram-sha-256 --auth-host=scram-sha-256 -E UTF8 --no-instructions >"$run_directory/initdb.log" 2>&1 \
  || { tail -n 5 "$run_directory/initdb.log" >&2; refuse 'initdb failed.'; }
printf "listen_addresses = '127.0.0.1'\nport = %s\nunix_socket_directories = ''\n" "$port" >> "$data_directory/postgresql.conf"
LC_ALL=en_US.UTF-8 "$pg_bin/pg_ctl" -D "$data_directory" -l "$run_directory/server.log" -w -t 30 start >/dev/null \
  || { tail -n 5 "$run_directory/server.log" >&2; refuse 'the disposable cluster did not start.'; }
cluster_pid=$(head -n 1 "$data_directory/postmaster.pid")

listening=$(lsof -nP -a -p "$cluster_pid" -iTCP -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $9}' | sort -u)
[ "$listening" = "127.0.0.1:$port" ] || refuse 'the cluster is not listening on exactly 127.0.0.1 and its port.'
if lsof -nP -a -p "$cluster_pid" -U 2>/dev/null | grep -q '\.s\.PGSQL'; then refuse 'the cluster opened a Unix socket.'; fi

psql_cluster() { PGPASSFILE="$pgpass_file" "$pg_bin/psql" -h 127.0.0.1 -p "$port" -U it_super -XAtq -v ON_ERROR_STOP=1 "$@"; }
reported_port=$(psql_cluster -d postgres -c "SELECT current_setting('port')")
reported_directory=$(psql_cluster -d postgres -c "SELECT current_setting('data_directory')")
[ "$reported_port" = "$port" ] || refuse 'the server reports a different port.'
[ "$(cd -- "$reported_directory" && pwd -P)" = "$(cd -- "$data_directory" && pwd -P)" ] || refuse 'the server reports a different data directory.'
psql_cluster -d postgres -c 'CREATE DATABASE eltnoy_grants_test' >/dev/null
databases=$(psql_cluster -d postgres -c "SELECT string_agg(datname, ',' ORDER BY datname) FROM pg_database WHERE NOT datistemplate")
[ "$databases" = 'eltnoy_grants_test,postgres' ] || refuse 'unexpected databases in the disposable cluster.'
note "Disposable cluster ready: 127.0.0.1:$port (only), database eltnoy_grants_test, data directory $data_directory"

# --- the test run: a clean environment, only what the harness needs --------------------------------
test_output="$run_directory/test.out"
set +e
(
  cd -- "$repository_root"
  env -i \
    PATH="$(dirname -- "$node_executable"):/usr/bin:/bin" \
    HOME="$HOME" TMPDIR="$run_directory" LANG="${LANG:-en_US.UTF-8}" \
    DOTENV_CONFIG_PATH=/dev/null \
    DATABASE_URL=postgresql://placeholder:placeholder@127.0.0.1:9/placeholder \
    ELTNOY_GRANTS_INTEGRATION=1 \
    ELTNOY_GRANTS_TEST_EXPECTED_PORT="$port" \
    ELTNOY_GRANTS_TEST_EXPECTED_DATA_DIR="$data_directory" \
    ELTNOY_GRANTS_TEST_PASSWORD_FILE="$password_file" \
    ELTNOY_GRANTS_TEST_DATABASE_URL="postgres://it_super@127.0.0.1:$port/eltnoy_grants_test" \
    "$node_executable" --import tsx --test server/databaseGrants.postgres.integration.test.ts
) >"$test_output" 2>&1
test_status=$?
set -e

# Print the results only after proving that the password does not appear in them.
# (-f reads the pattern from the file, so the password never appears in a process argument list.)
if grep -qF -f "$password_file" "$test_output"; then
  note 'The test output contained the password; it is NOT printed.'
  test_status=3
else
  cat "$test_output"
fi
note "Deadlocks in the server log: $(grep -c 'deadlock detected' "$run_directory/server.log" || true)"
exit "$test_status"
