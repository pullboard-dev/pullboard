#!/usr/bin/env node
/** Produce an artifact only from this host's actual admitted native release gate [C7,I15]. */
import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../../../index.js';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { output: { type: 'string' }, head: { type: 'string' }, 'person-override': { type: 'string' } }, allowPositionals: false });
import {
  releaseSource,
  runReleaseGate,
} from '../../../../gate/index.js';
import { fileSystemAdapter } from '../../../../fs/index.js';

const fs = fileSystemAdapter();
const landing = Object.freeze({ ...landingExecutionServices(), releaseSource, runReleaseGate });
if (!values.output || !values.head || landing.releaseSource(process.cwd()).head !== values.head) {
  throw new Error('release-gate needs --output and --head naming the exact accepted commit');
}
const result = await landing.runReleaseGate(process.cwd(), { personOverride: values['person-override'], executionServices: { runners: runnerExecutionServices(), landing } });
fs.mkdir(dirname(values.output), { recursive: true });
fs.copyFile(result.file, values.output, fs.constants.COPYFILE_EXCL);
console.log(`release gate ${values.head}: ${result.receipt.participation.required.length} executors, ${result.seconds}s of ${result.timing?.budgetSeconds ?? 900}s; native receipt ${result.file}`);
if (result.overBudget) {
  console.error(`[OVER_BUDGET] the release gate took ${result.seconds}s, past its ${result.timing.budgetSeconds}s budget; its receipt records this; speed up the slowest shard before releasing`);
  process.exitCode = 1;
}
