#!/usr/bin/env node
/** Produce an artifact only from this host's actual admitted native release gate [C7,I15]. */
import { runnerExecutionServices } from '../../../../runners/index.js';
import { landingExecutionServices } from '../../../../landing/index.js';
import {
  copyFileSync,
  constants,
  mkdirSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { output: { type: 'string' }, head: { type: 'string' }, 'person-override': { type: 'string' } }, allowPositionals: false });
import {
  releaseSource,
  runReleaseGate,
} from '../../../index.js';
const landing = Object.freeze({ ...landingExecutionServices(), releaseSource, runReleaseGate });
if (!values.output || !values.head || landing.releaseSource(process.cwd()).head !== values.head) {
  throw new Error('release-gate needs --output and --head naming the exact accepted commit');
}
const result = await landing.runReleaseGate(process.cwd(), { personOverride: values['person-override'], executionServices: { runners: runnerExecutionServices(), landing } });
mkdirSync(dirname(values.output), { recursive: true });
copyFileSync(result.file, values.output, constants.COPYFILE_EXCL);
console.log(`release gate ${values.head}: ${result.receipt.participation.required.length} executors, ${result.seconds}s; native receipt ${result.file}`);
