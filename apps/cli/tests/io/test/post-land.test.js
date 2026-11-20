/** The main-wide test job request pullboard serve hands the board API runs the project's gate command at the landed tip [V2,M1,#12182]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CELL_CONFIG } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellRepo } from '../../../../../packages/store/tests/fixtures/cell.js';
import { PULLED_JOB_ENV } from '../../../../../packages/gate/index.js';
import { TEST_OUTCOMES_PREFIX } from '../../../../../packages/gate/index.js';
import { TIMING_RUN_ID_ENV } from '../../../../../packages/gate/index.js';
import { FAILURE_DIAGNOSTICS_SOURCE } from '../../../../../packages/kernel/index.js';
import { GATE_NEEDS } from '../../../src/io/submit/pull.js';
import { GATE_RECEIPT } from '../../../src/io/submit/pull.js';
import { gateJobRun } from '../../../src/io/submit/pull.js';
import { testJobEntry } from '../../../src/io/test/pull.js';
import { postLandTestRequest } from '../../../src/io/test/post-land.js';

const TRUNK = 'b'.repeat(40);

test('cli.test.post-land.request-runs-gate: clause 1: the request runs the project gate command, its whole suite, at the landed tip through the test job entry, with the gate needs [V2,M1,#12182]', t => {
  const { root } = cellRepo(t, { real: true, config: { ...CELL_CONFIG, gate: 'npm test' } });
  const built = postLandTestRequest({ root, trunk: TRUNK });
  assert.deepEqual(built.needs, GATE_NEEDS, 'the job needs what a gate shard needs');
  assert.deepEqual(built.request.run, gateJobRun(), 'the runner runs it through the gate bootstrap');
  assert.equal(built.request.input.main, TRUNK, 'the entry is read from the landed tip');
  assert.equal(built.request.input.entry, testJobEntry(GATE_RECEIPT, PULLED_JOB_ENV, TIMING_RUN_ID_ENV, TEST_OUTCOMES_PREFIX, FAILURE_DIAGNOSTICS_SOURCE), 'the test job entry prints the receipt line the board reads');
  assert.deepEqual(built.request.input.data, { main: TRUNK, source: TRUNK, command: 'npm test', files: [] }, 'the gate command runs whole at the landed tip');
});

test('cli.test.post-land.no-gate-no-job: clause 1: a project with no gate command gets no request, so no job is queued [V2,M1,#12182]', t => {
  const { root } = cellRepo(t, { real: true, config: { ...CELL_CONFIG, gate: '' } });
  assert.equal(postLandTestRequest({ root, trunk: TRUNK }), null);
});
