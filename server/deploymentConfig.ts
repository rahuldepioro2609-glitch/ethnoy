export interface DeploymentConfig {
  deploymentMode?: string;
  databaseSsl?: string;
  databaseSslRejectUnauthorized?: string;
  postgresCaFile?: string;
  postgresTlsDir?: string;
  /** P1-D.2: host directory mounted only into the public Nginx (public certificate and key). */
  publicTlsCertDir?: string;
  /** P1-D.2: host directory mounted only into the Admin Nginx (Admin certificate and key). */
  adminTlsCertDir?: string;
  /** M-1: the API image reference used by api_public (built locally) and api_admin (reused). */
  apiImage?: string;
  /** M-2: host address the public Nginx publishes on (private ENI by default, explicit direct VPS mode otherwise). */
  publicBindAddress?: string;
  /** Explicitly selects the public Nginx host binding model. */
  publicBindMode?: string;
  /** M-2: host address the Admin Nginx publishes on; must equal wireguardInterfaceAddress. */
  adminBindAddress?: string;
  /** M-2: the address assigned to the host's WireGuard interface (wg0), declared by the operator. */
  wireguardInterfaceAddress?: string;
}

// ---------------------------------------------------------------------------
// M-1: local-only API image reference
// ---------------------------------------------------------------------------

/**
 * The only accepted ELTNOY_API_IMAGE form: `localhost/eltnoy-api:<tag>`. The image is built from
 * this repository (api_public: pull_policy build) and reused by api_admin (pull_policy never); a
 * registry-qualified, Docker Hub, digest or untagged reference is rejected so the tag can never be
 * resolved to, or replaced by, a registry image.
 */
export const LOCAL_API_IMAGE_PATTERN = /^localhost\/eltnoy-api:[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

// ---------------------------------------------------------------------------
// M-2: Nginx host bind addresses (literal IPv4 only; no DNS, no host inspection)
// ---------------------------------------------------------------------------

/** Strict dotted-quad IPv4 (no leading zeros, no ports, no brackets). */
function parseIpv4(text: string): number | null {
  if (!/^(?:0|[1-9][0-9]{0,2})(?:\.(?:0|[1-9][0-9]{0,2})){3}$/.test(text)) return null;
  const octets = text.split('.').map(Number);
  if (octets.some((octet) => octet > 255)) return null;
  return octets.reduce((value, octet) => value * 256 + octet, 0);
}

function inRange(value: number, base: string, prefix: number): boolean {
  const network = parseIpv4(base) as number;
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) === Math.floor(network / size);
}

export type AddressClass = 'unspecified' | 'loopback' | 'link_local' | 'multicast_or_reserved' | 'private' | 'shared' | 'public';

function classifyIpv4(value: number): AddressClass {
  if (inRange(value, '0.0.0.0', 8)) return 'unspecified';
  if (inRange(value, '127.0.0.0', 8)) return 'loopback';
  if (inRange(value, '169.254.0.0', 16)) return 'link_local';
  if (inRange(value, '224.0.0.0', 3)) return 'multicast_or_reserved';
  if (inRange(value, '10.0.0.0', 8) || inRange(value, '172.16.0.0', 12) || inRange(value, '192.168.0.0', 16)) return 'private';
  if (inRange(value, '100.64.0.0', 10)) return 'shared';
  return 'public';
}

/**
 * P1-D.3 (F-8): pure classification of one literal for tests and tooling. Returns 'invalid' for
 * anything that is not a strict dotted-quad IPv4 literal. Uses the same parser and classifier as
 * validateDeploymentConfig; it does not change the accepted-address policy.
 */
export function classifyIpv4Address(text: string): AddressClass | 'invalid' {
  const value = parseIpv4(text);
  return value === null ? 'invalid' : classifyIpv4(value);
}

/**
 * Validates one bind address. Returns the parsed value, or null after recording errors that name
 * the setting and the rule only (never the configured value).
 */
function checkBindAddress(name: string, raw: string | undefined, allowed: readonly AddressClass[], rule: string, errors: string[]): number | null {
  if (raw === undefined || raw === '') {
    errors.push(`${name} must be set.`);
    return null;
  }
  const value = parseIpv4(raw);
  if (value === null) {
    errors.push(`${name} must be a literal IPv4 address (IPv6, hostnames, ports, CIDR ranges and wildcards are not accepted).`);
    return null;
  }
  const kind = classifyIpv4(value);
  if (kind === 'unspecified') errors.push(`${name} must not be a wildcard or unspecified address.`);
  else if (kind === 'loopback') errors.push(`${name} must not be a loopback address.`);
  else if (kind === 'link_local') errors.push(`${name} must not be a link-local address.`);
  else if (kind === 'multicast_or_reserved') errors.push(`${name} must not be a multicast, reserved or broadcast address.`);
  else if (!allowed.includes(kind)) errors.push(`${name} ${rule}`);
  else return value;
  return null;
}

const certificatePathFields = [
  ['POSTGRES_CA_FILE', 'postgresCaFile'],
  ['POSTGRES_TLS_DIR', 'postgresTlsDir'],
  ['PUBLIC_TLS_CERT_DIR', 'publicTlsCertDir'],
  ['ADMIN_TLS_CERT_DIR', 'adminTlsCertDir'],
] as const;

/** Normalises a directory path for comparison (trailing separators and "." segments only). */
function normaliseDirectory(path: string): string {
  return path.replace(/[\\/]+$/, '').replace(/([\\/])\.(?=[\\/]|$)/g, '') || path;
}

const localDevelopmentPath = /(^|[\\/])\.local-dev([\\/]|$)/;

/**
 * P1-D.3 (F-4): the environment variable read for each DeploymentConfig field. This is the single
 * source of the mapping used by the in-container preflight and the host deployment wrapper.
 */
export const DEPLOYMENT_CONFIG_ENVIRONMENT = {
  deploymentMode: 'DEPLOYMENT_MODE',
  databaseSsl: 'DATABASE_SSL',
  databaseSslRejectUnauthorized: 'DATABASE_SSL_REJECT_UNAUTHORIZED',
  postgresCaFile: 'POSTGRES_CA_FILE',
  postgresTlsDir: 'POSTGRES_TLS_DIR',
  publicTlsCertDir: 'PUBLIC_TLS_CERT_DIR',
  adminTlsCertDir: 'ADMIN_TLS_CERT_DIR',
  apiImage: 'ELTNOY_API_IMAGE',
  publicBindAddress: 'PUBLIC_BIND_ADDRESS',
  publicBindMode: 'PUBLIC_BIND_MODE',
  adminBindAddress: 'ADMIN_BIND_ADDRESS',
  wireguardInterfaceAddress: 'WIREGUARD_INTERFACE_ADDRESS',
} as const satisfies Record<keyof DeploymentConfig, string>;

/**
 * P1-D.3 (F-4): pure environment-to-config mapping. Reads only the variables listed in
 * DEPLOYMENT_CONFIG_ENVIRONMENT from the explicit environment object it is given (never
 * process.env implicitly), returns exactly those fields, and never logs anything.
 */
export function deploymentConfigFromEnvironment(environment: Readonly<Record<string, string | undefined>>): DeploymentConfig {
  const config: DeploymentConfig = {};
  for (const [field, name] of Object.entries(DEPLOYMENT_CONFIG_ENVIRONMENT) as Array<[keyof DeploymentConfig, string]>) {
    config[field] = Object.prototype.hasOwnProperty.call(environment, name) ? environment[name] : undefined;
  }
  return config;
}

export function validateDeploymentConfig(config: DeploymentConfig): string[] {
  const errors: string[] = [];

  if (config.deploymentMode !== 'production' && config.deploymentMode !== 'development') {
    errors.push('DEPLOYMENT_MODE must be explicitly set to production or development.');
  }

  for (const [environmentName, field] of certificatePathFields) {
    const path = config[field];
    if (!path) {
      errors.push(`${environmentName} must be set.`);
    } else if (config.deploymentMode === 'production' && localDevelopmentPath.test(path)) {
      errors.push(`${environmentName} must not point inside .local-dev in production.`);
    }
  }

  // P1-D.2: the public and Admin Nginx must never share a certificate directory (and so never a
  // private key or a certificate naming the other surface's hostname).
  if (config.publicTlsCertDir && config.adminTlsCertDir
    && normaliseDirectory(config.publicTlsCertDir) === normaliseDirectory(config.adminTlsCertDir)) {
    errors.push('PUBLIC_TLS_CERT_DIR and ADMIN_TLS_CERT_DIR must be different directories.');
  }

  // M-1: local-only API image reference (no silent default).
  if (!config.apiImage) {
    errors.push('ELTNOY_API_IMAGE must be set.');
  } else if (!LOCAL_API_IMAGE_PATTERN.test(config.apiImage)) {
    errors.push('ELTNOY_API_IMAGE must be a local-only reference of the form localhost/eltnoy-api:<tag>; registry, Docker Hub, digest and untagged references are not accepted.');
  }

  // M-2: public-ingress binding. Cloud/VPC deployments bind the private ENI by default. A directly
  // addressed VPS may bind its public interface only when the operator explicitly selects
  // PUBLIC_BIND_MODE=direct-vps; the host firewall and DOCKER-USER Admin guard remain required.
  const publicBindMode = config.publicBindMode;
  if (publicBindMode !== 'private-eni' && publicBindMode !== 'direct-vps') {
    errors.push('PUBLIC_BIND_MODE must be set to private-eni or direct-vps.');
  }
  const publicBindClasses = publicBindMode === 'direct-vps' ? ['public'] as const : ['private'] as const;
  const publicBindRule = publicBindMode === 'direct-vps'
    ? 'must be a public IPv4 address assigned to this VPS; private, shared, loopback and wildcard addresses are not accepted.'
    : 'must be a private (RFC 1918) host address on the private interface; public and shared addresses are not accepted.';
  const publicBind = checkBindAddress('PUBLIC_BIND_ADDRESS', config.publicBindAddress, publicBindClasses,
    publicBindRule, errors);
  const wireguard = checkBindAddress('WIREGUARD_INTERFACE_ADDRESS', config.wireguardInterfaceAddress, ['private', 'shared'],
    'must be a private (RFC 1918) or shared (100.64.0.0/10) WireGuard tunnel address; public addresses are not accepted.', errors);
  const adminBind = checkBindAddress('ADMIN_BIND_ADDRESS', config.adminBindAddress, ['private', 'shared'],
    'must be the WireGuard interface address (private or shared range); public addresses are not accepted.', errors);
  if (adminBind !== null && wireguard !== null && adminBind !== wireguard) {
    errors.push('ADMIN_BIND_ADDRESS must equal WIREGUARD_INTERFACE_ADDRESS: the Admin Nginx binds only to the WireGuard interface address.');
  }
  if (publicBind !== null && (publicBind === adminBind || publicBind === wireguard)) {
    errors.push('PUBLIC_BIND_ADDRESS must differ from ADMIN_BIND_ADDRESS and WIREGUARD_INTERFACE_ADDRESS.');
  }

  if (config.databaseSsl !== 'true') {
    errors.push('DATABASE_SSL must be true to require PostgreSQL TLS.');
  }

  if (config.databaseSslRejectUnauthorized !== 'true') {
    errors.push('DATABASE_SSL_REJECT_UNAUTHORIZED must be true.');
  }

  return errors;
}
