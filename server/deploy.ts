// P1-D.3/P1-D.4: executable entry point of the deployment wrapper. Invoke it only through
// scripts/eltnoy-deploy.sh (see server/deploymentWrapper.ts and server/deploymentRunner.ts for the
// guarantees and limits). Prints setting names and fixed messages only; never configured values.
import { spawnSync } from 'node:child_process';
import { constants as osConstants, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDeployment } from './deploymentRunner.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// Defer termination signals until the generated env file has been removed. Immediately before
// Docker would start, the runner yields to the event loop (so a signal received earlier is
// delivered) and does not start Docker if one was received (P4-6). While Docker runs (spawnSync),
// a terminal interrupt reaches Docker directly; this process exits afterwards.
const received: NodeJS.Signals[] = [];
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => received.push(signal));

const exitCode = await runDeployment({
  argv: process.argv.slice(2),
  environment: process.env,
  currentUid: process.getuid?.(),
  repositoryRoot,
  temporaryRoot: tmpdir(),
  nodeExecutable: process.execPath,
  runDocker: (dockerPath, dockerArguments, environment) => {
    const child = spawnSync(dockerPath, dockerArguments, { cwd: repositoryRoot, env: environment, stdio: 'inherit', shell: false });
    return { status: child.status, errorCode: child.error ? String((child.error as NodeJS.ErrnoException).code ?? 'unknown') : undefined };
  },
  log: (line) => console.log(line),
  error: (line) => console.error(line),
  beforeDocker: () => new Promise<void>((resolve) => { setImmediate(resolve); }),
  cancellationRequested: () => received.length > 0,
});

process.exit(received.length > 0 ? 128 + (osConstants.signals[received[0]] ?? 0) : exitCode);
