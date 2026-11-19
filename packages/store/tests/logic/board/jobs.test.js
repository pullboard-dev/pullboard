/** A recurring round is due once its cadence has passed, by the one cadence parser the jobs use [D1,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cadenceMs } from '../../../src/logic/board/jobs.js';
import { recurringRoundDue } from '../../../src/logic/board/jobs.js';

test('store.logic-board-jobs.recurring-round-due: clause 1: recurring round is due once its cadence has passed [D1,C7]', () => {
  const lastRoundAt = 1_000_000;
  const due = lastRoundAt + cadenceMs('10m');
  assert.equal(recurringRoundDue({ every: '10m', lastRoundAt, now: due - 1 }), false);
  assert.equal(recurringRoundDue({ every: '10m', lastRoundAt, now: due }), true);
  assert.equal(recurringRoundDue({ every: 'daily', lastRoundAt, now: lastRoundAt + 86_400_000 }), true);
  assert.throws(() => recurringRoundDue({ every: '5s', lastRoundAt, now: due }), { code: 'BAD_JOB' });
});
