#!/usr/bin/env bash
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
    const app = services.app;
    const postgres = services.postgres;
    const appEnv = app && app.environment;
    const dbEnv = postgres && postgres.environment;
    const databaseUrl = new URL(appEnv && appEnv.DATABASE_URL);
    const valid =
      appEnv.DEPLOYMENT_MODE === "development" &&
      appEnv.DATABASE_SSL === "true" &&
      appEnv.DATABASE_SSL_REJECT_UNAUTHORIZED === "true" &&
      databaseUrl.protocol === "postgresql:" &&
      databaseUrl.hostname === "postgres" &&
      databaseUrl.pathname === "/eltnoy_dev" &&
      databaseUrl.username === "eltnoy_dev" &&
      dbEnv.POSTGRES_DB === "eltnoy_dev" &&
      dbEnv.POSTGRES_USER === "eltnoy_dev" &&
      dbEnv.POSTGRES_PASSWORD === "local-only-not-for-production" &&
      !Object.hasOwn(postgres, "ports");
    if (!valid) {
      console.error("FAIL: effective Compose configuration is not the isolated local development database.");
      process.exitCode = 1;
      return;
    }
    console.log("PASS: effective Compose configuration targets only the isolated local development database.");
  } catch {
    console.error("FAIL: could not validate the effective Compose configuration.");
    process.exitCode = 1;
  }
});
'

running_postgres="$("${compose[@]}" ps --status running -q postgres)"
running_app="$("${compose[@]}" ps --status running -q app)"
if [[ -z "$running_postgres" || -z "$running_app" ]]; then
  echo "FAIL: local development app and PostgreSQL must already be running; this script will not start containers." >&2
  exit 1
fi

"${compose[@]}" exec -T app node --input-type=module -e '
import pg from "pg";

const expected = {
  mode: "development",
  host: "postgres",
  database: "eltnoy_dev",
  user: "eltnoy_dev",
};
const url = new URL(process.env.DATABASE_URL || "");
if (
  process.env.DEPLOYMENT_MODE !== expected.mode ||
  process.env.DATABASE_SSL !== "true" ||
  process.env.DATABASE_SSL_REJECT_UNAUTHORIZED !== "true" ||
  url.hostname !== expected.host ||
  url.pathname !== `/${expected.database}` ||
  url.username !== expected.user
) {
  console.error("FAIL: app environment is not configured for the isolated local development database.");
  process.exit(1);
}

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true },
  max: 1,
});
let client;
let transactionOpen = false;
let failed = false;

try {
  client = await pool.connect();
  await client.query("BEGIN");
  transactionOpen = true;

  const identity = await client.query(
    "SELECT current_database() AS database, current_user AS username, (SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()) AS tls",
  );
  const connected = identity.rows[0];
  if (
    connected.database !== expected.database ||
    connected.username !== expected.user ||
    connected.tls !== true
  ) {
    throw new Error("Connected database identity or TLS verification did not match the development target.");
  }

  await client.query(
    "CREATE TEMP TABLE eltnoy_integration_probe (id integer PRIMARY KEY, value text NOT NULL) ON COMMIT DROP",
  );
  await client.query(
    "INSERT INTO eltnoy_integration_probe (id, value) VALUES ($1, $2)",
    [1, "before-update"],
  );
  const selected = await client.query(
    "SELECT value FROM eltnoy_integration_probe WHERE id = $1",
    [1],
  );
  if (selected.rows[0]?.value !== "before-update") {
    throw new Error("Temporary-row SELECT did not return the inserted value.");
  }

  const updated = await client.query(
    "UPDATE eltnoy_integration_probe SET value = $2 WHERE id = $1 RETURNING value",
    [1, "after-update"],
  );
  if (updated.rows[0]?.value !== "after-update") {
    throw new Error("Temporary-row UPDATE did not return the updated value.");
  }

  await client.query("ROLLBACK");
  transactionOpen = false;
  console.log("PASS: verified TLS connection and INSERT/SELECT/UPDATE in a transaction; ROLLBACK completed.");
} catch (error) {
  failed = true;
  if (transactionOpen && client) {
    try {
      await client.query("ROLLBACK");
      transactionOpen = false;
      console.error("PASS: failed test transaction was rolled back.");
    } catch {
      console.error("FAIL: could not confirm transaction rollback; PostgreSQL will roll back when the connection closes.");
    }
  }
  const code = error && typeof error === "object" && "code" in error
    ? ` (error code ${String(error.code)})`
    : "";
  console.error(`FAIL: local development database integration test failed${code}.`);
  process.exitCode = 1;
} finally {
  client?.release();
  await pool.end();
}

if (failed) process.exitCode = 1;
'
