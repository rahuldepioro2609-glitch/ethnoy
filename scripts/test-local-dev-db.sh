#!/usr/bin/env bash
# Non-destructive check of the local development stack (UD-1 role separation).
# Refuses to start containers. Verifies the effective Compose configuration (eltnoy_app with a
# password-file secret from .local-dev/secrets, hardened API container), then, inside the running app
# container, the TLS connection, the database identity and the API role's privilege boundaries in a
# READ ONLY transaction that is rolled back. It never writes to any table and never prints a secret.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
env_file="$repo_root/.env.development"
compose_file="$repo_root/docker-compose.yml"

if ! command -v docker >/dev/null 2>&1; then
  echo "FAIL: Docker is required; no database test was run." >&2
  exit 1
fi

if [[ ! -f "$env_file" || ! -f "$compose_file" ]]; then
  echo "FAIL: local Compose development configuration is missing." >&2
  exit 1
fi

compose=(docker compose --env-file "$env_file" -f "$compose_file")

"${compose[@]}" config --format json | node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  try {
    const config = JSON.parse(input);
    const services = config.services || {};
    const app = services.api_public;
    const postgres = services.postgres;
    const appEnv = app && app.environment;
    const dbEnv = postgres && postgres.environment;
    const databaseUrl = new URL(appEnv && appEnv.DATABASE_URL);
    const secretFiles = Object.values(config.secrets || {}).map((secret) => String(secret.file || ""));
    const appSecrets = (app.secrets || []).map((secret) => secret.source);
    const valid =
      appEnv.DEPLOYMENT_MODE === "development" &&
      appEnv.DATABASE_SSL === "true" &&
      appEnv.DATABASE_SSL_REJECT_UNAUTHORIZED === "true" &&
      databaseUrl.protocol === "postgresql:" &&
      databaseUrl.hostname === "postgres" &&
      databaseUrl.pathname === "/eltnoy_dev" &&
      databaseUrl.username === "eltnoy_app" &&
      databaseUrl.password === "" &&
      appEnv.DATABASE_PASSWORD_FILE === "/run/secrets/eltnoy_app_password" &&
      JSON.stringify(appSecrets) === JSON.stringify(["eltnoy_app_password"]) &&
      app.user === "10001:10001" &&
      app.read_only === true &&
      dbEnv.POSTGRES_DB === "eltnoy_dev" &&
      dbEnv.POSTGRES_USER === "eltnoy_dev" &&
      dbEnv.POSTGRES_PASSWORD_FILE === "/run/secrets/postgres_superuser_password" &&
      !Object.hasOwn(dbEnv, "POSTGRES_PASSWORD") &&
      secretFiles.length > 0 &&
      secretFiles.every((file) => file.includes("/.local-dev/secrets/")) &&
      !Object.hasOwn(postgres, "ports");
    if (!valid) {
      console.error("FAIL: effective Compose configuration is not the isolated local development database with role separation.");
      process.exitCode = 1;
      return;
    }
    console.log("PASS: effective Compose configuration targets only the isolated local development database, as eltnoy_app with .local-dev secrets.");
  } catch {
    console.error("FAIL: could not validate the effective Compose configuration.");
    process.exitCode = 1;
  }
});
'

running_postgres="$("${compose[@]}" ps --status running -q postgres)"
running_app="$("${compose[@]}" ps --status running -q api_public)"
if [[ -z "$running_postgres" || -z "$running_app" ]]; then
  echo "FAIL: local development app and PostgreSQL must already be running; this script will not start containers." >&2
  exit 1
fi

"${compose[@]}" exec -T api_public node --import tsx --input-type=module -e '
import pg from "pg";
import { databasePoolConfig } from "/app/server/databaseCredentials.ts";

const expected = { mode: "development", host: "postgres", database: "eltnoy_dev", user: "eltnoy_app" };
const url = new URL(process.env.DATABASE_URL || "");
if (
  process.env.DEPLOYMENT_MODE !== expected.mode ||
  process.env.DATABASE_SSL !== "true" ||
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "true" ||
  url.hostname !== expected.host ||
  url.pathname !== `/${expected.database}` ||
  url.username !== expected.user ||
  url.password !== "" ||
  !process.env.DATABASE_PASSWORD_FILE
) {
  console.error("FAIL: app environment is not configured for the isolated local development database.");
  process.exit(1);
}

const pool = new pg.Pool({ ...databasePoolConfig(process.env), max: 1 });
let client;
try {
  client = await pool.connect();
  await client.query("BEGIN READ ONLY");
  const { rows } = await client.query(`
    SELECT current_database() AS database, current_user AS username,
           (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls,
           (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
           has_table_privilege(current_user, $$public.users$$, $$SELECT$$) AS can_select_users,
           has_table_privilege(current_user, $$public.users$$, $$DELETE$$) AS can_delete_users,
           has_column_privilege(current_user, $$public.users$$, $$is_super_admin$$, $$UPDATE$$) AS can_promote,
           has_database_privilege(current_user, current_database(), $$TEMPORARY$$) AS can_create_temp`);
  const r = rows[0];
  await client.query("SELECT 1 FROM users LIMIT 1");
  await client.query("ROLLBACK");
  const ok = r.database === expected.database && r.username === expected.user && r.tls === true && r.superuser === false &&
    r.can_select_users === true && r.can_delete_users === false && r.can_promote === false && r.can_create_temp === false;
  if (!ok) {
    throw new Error("Connected identity, TLS or privilege boundaries did not match the role-separated development target.");
  }
  console.log("PASS: verified TLS connection as eltnoy_app (not superuser); SELECT allowed; DELETE, is_super_admin UPDATE and TEMP denied; READ ONLY transaction rolled back.");
} catch (error) {
  try { await client?.query("ROLLBACK"); } catch {}
  const code = error && typeof error === "object" && "code" in error ? ` (error code ${String(error.code)})` : "";
  console.error(`FAIL: local development database check failed${code}.`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}
'
