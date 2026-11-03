export interface DeploymentConfig {
  deploymentMode?: string;
  databaseSsl?: string;
  databaseSslRejectUnauthorized?: string;
  postgresCaFile?: string;
  postgresTlsDir?: string;
  tlsCertDir?: string;
}

const certificatePathFields = [
  ['POSTGRES_CA_FILE', 'postgresCaFile'],
  ['POSTGRES_TLS_DIR', 'postgresTlsDir'],
  ['TLS_CERT_DIR', 'tlsCertDir'],
] as const;

const localDevelopmentPath = /(^|[\\/])\.local-dev([\\/]|$)/;

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

  if (config.databaseSsl !== 'true') {
    errors.push('DATABASE_SSL must be true to require PostgreSQL TLS.');
  }

  if (config.databaseSslRejectUnauthorized !== 'true') {
    errors.push('DATABASE_SSL_REJECT_UNAUTHORIZED must be true.');
  }

  return errors;
}
