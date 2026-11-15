#!/usr/bin/env node
/** Check delete-tagged journeys against their covering cells' mutation scores: `node apps/cli/src/io/mutate/journey-check.js [--limit n] [--write]` [C7]. */
import { runJourneyCheck } from '../../../../../packages/gate/index.js';
import { mutateCell } from './run.js';

// Each line is printed as it is known, so a run that is killed has still printed its verdicts; the returned stdout is the same lines.
const { status, stderr } = await runJourneyCheck(process.argv.slice(2), { mutate: mutateCell, say: line => process.stdout.write(`${line}\n`), trace: line => process.stderr.write(`${line}\n`) });
if (stderr) process.stderr.write(stderr);
process.exitCode = status;
