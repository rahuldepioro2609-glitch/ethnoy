import { validateDeploymentConfig } from './deploymentConfig.js';

const errors = validateDeploymentConfig({
  deploymentMode: process.env.DEPLOYMENT_MODE,
  databaseSsl: process.env.DATABASE_SSL,
  databaseSslRejectUnauthorized: process.env.DATABASE_SSL_REJECT_UNAUTHORIZED,
  postgresCaFile: process.env.POSTGRES_CA_FILE,
  postgresTlsDir: process.env.POSTGRES_TLS_DIR,
  tlsCertDir: process.env.TLS_CERT_DIR,
});

if (errors.length > 0) {
  console.error(`Invalid deployment configuration:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  process.exit(1);
}
