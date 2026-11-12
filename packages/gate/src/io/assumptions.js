#!/usr/bin/env node
/**
 * Doctrine check: core code names no test runner or operating system [C7].
 *
 * The engine lives in the codemap cell (packages/codemap/src/io/no-runtime-assumptions.js); this launcher runs it
 * from the command line and when a caller imports it. `--counts` prints today's counts, `--write` lowers the baseline
 * in no-runtime-assumptions.json, and `--check` (the default) refuses growth.
 *
 * @file-local Reads the config and the sources under the root, through the engine.
 */
import { existsSync } from 'node:fs';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assumptionCounts } from '../../../codemap/index.js';
import { assumptionProblems } from '../../../codemap/index.js';
import { assumptionsIn } from '../../../codemap/index.js';
import { writeAssumptionBaseline } from '../../../codemap/index.js';
import { report } from './scan.js';
import { runCheck } from './scan.js';

export { assumptionProblems, assumptionsIn, writeAssumptionBaseline };

const MAIN = Boolean(process.argv[1]) && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
const rootArgument = () => resolve(process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? '.');

if (MAIN && process.argv.includes('--counts')) console.log(JSON.stringify(assumptionCounts(rootArgument()), null, 2));
else if (MAIN && process.argv.includes('--write')) report(writeAssumptionBaseline(rootArgument()));
else if (MAIN) report(assumptionProblems(rootArgument())); // --check is the default
else runCheck(import.meta, assumptionProblems);
