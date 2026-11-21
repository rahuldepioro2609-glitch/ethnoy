import { createVerifierHttpServer } from './httpServer.js';
import { loadVerifierKeys } from './keys.js';
import { JsonSecurityEventLogger } from './securityEvents.js';
import { parseVerifierConfig, VerifierConfigurationError } from './config.js';

const logger = new JsonSecurityEventLogger();

function start(): void {
  let config;
  let keys;
  try {
    config = parseVerifierConfig(process.env);
    keys = loadVerifierKeys(config);
  } catch (error) {
    const code = error instanceof VerifierConfigurationError ? error.code : 'VERIFIER_STARTUP_FAILED';
    logger.write({ event: 'verifier_startup_failed', outcome: 'failure', code });
    process.exitCode = 1;
    return;
  }

  const server = createVerifierHttpServer({ logger, ready: () => false });
  server.on('error', () => {
    logger.write({ event: 'verifier_startup_failed', outcome: 'failure', code: 'LISTEN_FAILED' });
    keys.destroy();
    process.exitCode = 1;
  });
  server.listen(config.port, config.bindHost, () => {
    logger.write({ event: 'verifier_started', outcome: 'success' });
  });

  const shutdown = () => {
    server.close(() => {
      keys.destroy();
      process.exitCode = 0;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

start();
