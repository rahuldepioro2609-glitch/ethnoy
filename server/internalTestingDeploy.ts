import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { internalTestingMain } from './internalTestingDeployment.js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.exit(internalTestingMain(process.argv.slice(2), repositoryRoot));
