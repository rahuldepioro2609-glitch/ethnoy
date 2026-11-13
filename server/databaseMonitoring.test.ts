// Static checks for the OD-P6 monitoring setup (server/databaseMonitoringSetup.sql). No database.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { MIGRATION_FILES } from './migrate.js';

const FILE = 'databaseMonitoringSetup.sql';
const read = async () => (await readFile(new URL(FILE, import.meta.url), 'utf8')).replace(/--[^\n]*/g, '');

test('monitoring setup is an operator-run, superuser-only, password-free script, not a migration', async () => {
  const sql = await read();
  assert.ok(!(MIGRATION_FILES as readonly string[]).includes(FILE));
  assert.match(sql, /IF NOT \(SELECT rolsuper FROM pg_roles WHERE rolname = current_user\) THEN\s+RAISE EXCEPTION/);
  assert.doesNotMatch(sql, /\b(ENCRYPTED\s+)?PASSWORD\s+(['$:]|E'|NULL)/i);
  assert.doesNotMatch(sql, /\b(DROP|TRUNCATE|DELETE\s+FROM|UPDATE\s+\w+\s+SET|INSERT\s+INTO|REASSIGN\s+OWNED)\b/i);
  assert.doesNotMatch(sql, /^\s*(BEGIN|COMMIT|ROLLBACK)\s*;/im);
});

test('eltnoy_monitor gets no predefined role, membership, ownership, business-table access or elevated attribute', async () => {
  const sql = await read();
  assert.match(sql, /ALTER ROLE eltnoy_monitor LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT \d+;/);
  assert.match(sql, /ALTER ROLE eltnoy_monitor_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;/);
  const grantsToMonitor = [...sql.matchAll(/GRANT\s+([^;]*?)\s+TO\s+eltnoy_monitor\b(?!_)/gi)].map((m) => m[1].replace(/\s+/g, ' '));
  for (const grant of grantsToMonitor) {
    assert.match(grant, /^(CONNECT ON DATABASE %I|USAGE ON SCHEMA eltnoy_monitoring|EXECUTE ON ALL FUNCTIONS IN SCHEMA eltnoy_monitoring)$/, `unexpected grant to eltnoy_monitor: ${grant}`);
  }
  assert.doesNotMatch(sql, /GRANT\s+(pg_\w+|eltnoy_\w+)\s+TO\s+eltnoy_monitor\b(?!_)/i, 'eltnoy_monitor must not be granted any role');
  const roleGrants = [...sql.matchAll(/GRANT\s+(pg_\w+)\s+TO\s+(\w+)/gi)].map((m) => `${m[1]}→${m[2]}`);
  assert.deepEqual(roleGrants, ['pg_read_all_stats→eltnoy_monitor_reader'], 'only pg_read_all_stats, and only to the NOLOGIN definer');
  assert.doesNotMatch(sql, /pg_monitor\b(?!ing)|pg_read_all_settings|pg_read_all_data|pg_write_all_data|pg_signal_backend|pg_stat_scan_tables|pg_execute_server_program|pg_read_server_files/,
    'no broader predefined role may be referenced in a grant');
  assert.doesNotMatch(sql, /ON SCHEMA public|ON (ALL )?TABLES?\b/i, 'no business-table or public-schema access');
  assert.match(sql, /eltnoy_monitor must not be a member of any role/);
});

test('every SECURITY DEFINER function pins search_path, is owned by the NOLOGIN definer, and returns no query text', async () => {
  const sql = await read();
  const functions = [...sql.matchAll(/CREATE OR REPLACE FUNCTION (eltnoy_monitoring\.\w+)\(([^)]*)\)([\s\S]*?)\$\$([\s\S]*?)\$\$;/g)];
  assert.equal(functions.length, 5);
  for (const [, name, args, header, body] of functions) {
    assert.match(header, /SET search_path = pg_catalog, pg_temp/, `${name} must pin search_path`);
    assert.doesNotMatch(header, /RETURNS TABLE \([^)]*\bquery\b/i, `${name} must not return query text`);
    if (/SECURITY DEFINER/.test(header)) {
      assert.doesNotMatch(body, /\ba\.query\s*(,|$)|\bw\.query\s*,|\bb\.query\s*,/m, `${name} may only pass query text to statement_kind()`);
      assert.doesNotMatch(body, /EXECUTE\b|format\(|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|set_config/i, `${name} must be fixed, read-only SQL`);
    }
    const signature = `${name}(${args.replace(/\s*\w+\s+(interval|text)(\s+DEFAULT[^,)]*)?/g, '$1').trim()})`;
    assert.match(sql, new RegExp(`ALTER FUNCTION ${signature.replace(/[.()]/g, '\\$&')} OWNER TO eltnoy_monitor_reader;`), `${signature} owner`);
  }
  assert.match(sql, /REVOKE ALL ON ALL FUNCTIONS IN SCHEMA eltnoy_monitoring FROM PUBLIC;/);
  assert.match(sql, /REVOKE ALL ON SCHEMA eltnoy_monitoring FROM PUBLIC;/);
});
