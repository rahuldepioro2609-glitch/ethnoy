// Deployment preflight. Runs inside each API container before the API starts (docker-compose.yml).
// On the host, run it ONLY through the deployment wrapper (P1-D.3; README / runbook §14.8):
//   scripts/eltnoy-deploy.sh --deployment-env-file /absolute/path/.env.production preflight
// The wrapper parses the env file once and validates and passes the same values to Compose.
// Errors name settings and rules only; configured values are never printed.
import { deploymentConfigFromEnvironment, validateDeploymentConfig } from './deploymentConfig.js';

const errors = validateDeploymentConfig(deploymentConfigFromEnvironment(process.env));

if (errors.length > 0) {
  console.error(`Invalid deployment configuration:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  process.exit(1);
}
