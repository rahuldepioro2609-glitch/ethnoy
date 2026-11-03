export const INSTITUTION_INTEGRATION_DATABASE = 'eltnoy_institution_test';

export function validateInstitutionIntegrationDatabaseUrl(value: string | undefined): URL {
  if (!value) {
    throw new Error('A dedicated institution integration database URL is required.');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The institution integration database URL is invalid.');
  }

  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const port = Number(url.port);
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol)
    || !['127.0.0.1', '::1'].includes(hostname)
    || decodeURIComponent(url.pathname.slice(1)) !== INSTITUTION_INTEGRATION_DATABASE
    || !url.port
    || port < 49152
    || port > 65535
    || url.search
    || url.hash
  ) {
    throw new Error('Only a loopback connection to the dedicated institution integration database is allowed.');
  }

  return url;
}

export function buildInstitutionIntegrationSchemaUrl(
  target: URL,
  schemaName: string,
): string {
  if (!/^it_[0-9a-f]{32}$/.test(schemaName)) {
    throw new Error('The isolated institution integration schema name is invalid.');
  }

  const url = new URL(target);
  url.searchParams.set('options', `-c search_path=${schemaName}`);
  return url.toString();
}
