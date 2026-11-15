#!/usr/bin/env node
/** Check delete-tagged journeys against their covering cells' mutation scores: `node apps/cli/src/io/mutate/journey-check.js [--limit n] [--write]` [C7]. */
import { runJourneyCheck } from '../../../../../packages/gate/index.js';
import { mutateCell } from './run.js';

const { status, stdout, stderr } = await runJourneyCheck(process.argv.slice(2), { mutate: mutateCell });
if (stdout) process.stdout.write(stdout);
if (stderr) process.stderr.write(stderr);
process.exitCode = status;
