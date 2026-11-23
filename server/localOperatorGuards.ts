// Guards shared by the local-development operator CLIs (adminMfaLocalBootstrap.ts and
// resetSuperAdminPassword.ts). Those tools are never part of the API process; they refuse to run
// unless DATABASE_URL names a loopback PostgreSQL host. Error messages never echo the URL.

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '::1']);

/**
 * Connection parameters that node-postgres (pg-connection-string) and libpq read from the query
 * string and that take precedence over the URL's host, e.g. postgresql://u@localhost/db?host=remote.
 */
const HOST_OVERRIDE_PARAMETERS: ReadonlySet<string> = new Set(['host', 'hostaddr']);

export class LocalOperatorGuardError extends Error {}

/** Returns the loopback host that DATABASE_URL connects to, or throws without revealing the URL. */
export function loopbackDatabaseHost(databaseUrl: string | undefined): string {
  if (!databaseUrl) throw new LocalOperatorGuardError('DATABASE_URL is required so the database target can be checked.');
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new LocalOperatorGuardError('DATABASE_URL is not a valid postgresql:// URL.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    throw new LocalOperatorGuardError('DATABASE_URL must use the postgresql:// scheme.');
  }
  for (const name of url.searchParams.keys()) {
    if (HOST_OVERRIDE_PARAMETERS.has(name.toLowerCase())) {
      throw new LocalOperatorGuardError('DATABASE_URL must not override its host with a query parameter.');
    }
  }
  const host = url.hostname.replace(/^\[(.*)\]$/, '$1').toLowerCase();
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new LocalOperatorGuardError('Refusing a non-loopback database host. Local operator tools run only against a loopback database.');
  }
  return host;
}
