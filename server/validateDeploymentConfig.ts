// Deployment preflight. Runs inside each API container before the API starts (docker-compose.yml).
// On the host, run it ONLY through the deployment wrapper (P1-D.3; README / runbook §14.8):
//   scripts/eltnoy-deploy.sh --deployment-env-file /absolute/path/.env.production preflight
// The wrapper parses the env file once and validates and passes the same values to Compose.
// Errors name settings and rules only; configured values are never printed.
// AUTH C1.3-B: the SMS limits and claim lifetime use the PURE shared resolver (smsProtectionConfig.ts),
// never authVerification.ts, so no database, Express, dotenv or credential module is loaded here.
import { deploymentConfigFromEnvironment, validateDeploymentConfig } from './deploymentConfig.js';
import { validateEmailProtectionDeployment, validateSmsProtectionDeployment } from './smsProtectionConfig.js';

const errors = [
  ...validateDeploymentConfig(deploymentConfigFromEnvironment(process.env)),
  ...validateSmsProtectionDeployment(process.env),
  // AUTH C1.4-B-2: the six email settings, same all-or-nothing pattern (independent of SMS).
  ...validateEmailProtectionDeployment(process.env),
];

if (errors.length > 0) {
  console.error(`Invalid deployment configuration:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  process.exit(1);
}
