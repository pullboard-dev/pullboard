/** Exact paired-runner tools, without unrelated scenario imports or lifecycle registration [C7]. */
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { runFixtureChild } from './fixture-child.js';
import { createE2eHelpers } from './e2e-helpers.js';
import { cli } from './runner-tooling-fixture.js';
import { startToolingCli } from './runner-tooling-fixture.js';
import { awaitRoundTrip } from './runner-tooling-fixture.js';
import { phaseCounts } from './runner-tooling-fixture.js';
import { ROUND_TRIP_DEADLINES } from './runner-tooling-fixture.js';
import { HOST } from './runner-ssh-fixture.js';
import { shellQuote } from './runner-ssh-fixture.js';
import { installSshStandIn } from './runner-ssh-fixture.js';
import { stopGroup } from './runner-process-group.js';

/** Original PAIRED_RERUN_FIXTURE fixture fragment; source bytes retained. */
const PAIRED_RERUN_FIXTURE = { createE2eHelpers, cli, observe, startToolingCli, awaitRoundTrip, phaseCounts,
  ROUND_TRIP_DEADLINES, HOST, shellQuote, installSshStandIn, processesUnder, stopGroup };

/** Original observe fixture fragment; source bytes retained. */
function observe(child) {
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8').on('data', part => { stdout += part; });
  child.stderr.setEncoding('utf8').on('data', part => { stderr += part; });
  const closed = once(child, 'close').then(([status, signal]) => ({ status, signal, stdout, stderr }));
  return { child, closed };
}

/** Original processesUnder fixture fragment; source bytes retained. */
function processesUnder(dir) {
  const listed = runFixtureChild('/bin/ps', ['-axo', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 });
  assert.equal(listed.status, 0, listed.context);
  return listed.stdout.split('\n').filter(line => line.includes(dir) && !line.includes('/bin/ps'));
}

export { PAIRED_RERUN_FIXTURE, observe, processesUnder };
