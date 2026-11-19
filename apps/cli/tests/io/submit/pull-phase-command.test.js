/** The command a failing proof phase ran rides its receipt row, as the pulled gate job script records it [C7]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../../packages/api/index.js';
import { jobsOf } from '../../../../../packages/jobs/index.js';
import { pullProject } from '../../fixtures/pull.js';
import { pullQueue } from '../../fixtures/pull.js';
import { serveOnce } from '../../fixtures/pull.js';
import { submitOne } from '../../fixtures/pull.js';

/** A one-line check that passes when the board adds the item and fails inside a pulled job. */
const FAILING_CHECK = `node -e 'process.env.PULLBOARD_PULLED_JOB && process.exit(1)'`;

test('cli.io-submit-pull-phase-command.runner-records-command: clause 2: the pulled job script records the command a failing phase ran on that phase\'s receipt row [C7]', { timeout: 240_000 }, async t => {
  const box = await pullProject(t, 1, { check: () => FAILING_CHECK });
  const [id] = box.ids;
  submitOne(box, id);
  const { board, url } = await pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
  const receiptOf = () => jobsOf(board.db, { kind: 'gate', item: id })[0]?.steps.find(step => step.name === 'receipt')?.payload?.receipt ?? null;
  for (let round = 0; round < 4 && !receiptOf(); round++) {
    const served = await serveOnce(box, url, `r-cmd-${round}`, {});
    assert.equal(served.code, 0, served.output);
  }
  const red = receiptOf()?.gate?.phases?.find(phase => phase?.status !== 0);
  assert.ok(red, 'the gate job posted a red phase');
  assert.equal(red.command, FAILING_CHECK);
});
