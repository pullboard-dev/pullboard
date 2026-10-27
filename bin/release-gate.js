#!/usr/bin/env node
/** Produce an artifact only from this host's actual admitted native release gate [C7,I15]. */
import { copyFileSync, constants, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseArgs } from 'node:util';
import { runReleaseGate, releaseSource } from '../src/release-gate.js';

const { values } = parseArgs({ options: { output: { type: 'string' }, head: { type: 'string' } }, allowPositionals: false });
if (!values.output || !values.head || releaseSource(process.cwd()).head !== values.head) {
  throw new Error('release-gate needs --output and --head naming the exact accepted commit');
}
const result = await runReleaseGate(process.cwd());
mkdirSync(dirname(values.output), { recursive: true });
copyFileSync(result.file, values.output, constants.COPYFILE_EXCL);
console.log(`release gate ${values.head}: ${result.receipt.participation.required.length} executors, ${result.seconds}s; native receipt ${result.file}`);
