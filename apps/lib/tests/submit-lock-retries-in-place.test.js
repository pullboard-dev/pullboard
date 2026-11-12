/** A lock stop in a queued submit retries at the call that met it, never restarting the submit from the top [C7,#3370]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { submitUntilSettled } from '../index.js';
import { Refused } from '../../../packages/kernel/index.js';

const options = (extra = {}) => ({ healthy: async () => true, wait: async () => {}, lockSleep: () => {}, say: () => {}, ...extra });

test('clause 1: a board call that throws SLOT_DB_LOCKED twice then succeeds finishes the submit with each stage run once and two lock waits recorded [C7,#3370]', async () => {
  const stages = { selection: 0, proof: 0, cells: 0 };
  let board = 0;
  const out = await submitUntilSettled(async (attempt, avoided, inPlace) => {
    stages.selection += 1; stages.proof += 1;
    const answer = await inPlace(async () => { if (++board <= 2) throw new Refused('SLOT_DB_LOCKED', 'fixture lock'); return 'recorded'; });
    stages.cells += 1;
    return answer;
  }, options());
  assert.equal(out.result, 'recorded');
  assert.deepEqual(stages, { selection: 1, proof: 1, cells: 1 });
  assert.equal(out.attempts.length, 0);
  assert.deepEqual(out.lockWaits, { count: 2, totalMs: 750, codes: { SLOT_DB_LOCKED: 2 } });
});

test('clause 1: a synchronous BOARD_BUSY retries in place with back-off from 250 ms, and another error goes up unchanged [C7,#3370]', async () => {
  const pauses = [];
  let calls = 0;
  const out = await submitUntilSettled(async (attempt, avoided, inPlace) => {
    const value = inPlace(() => { if (++calls <= 3) throw new Refused('BOARD_BUSY', 'fixture busy'); return 'ok'; });
    assert.throws(() => inPlace(() => { throw new Refused('NOT_YOURS', 'not a lock'); }), { code: 'NOT_YOURS' });
    return value;
  }, options({ lockSleep: ms => pauses.push(ms) }));
  assert.equal(out.result, 'ok');
  assert.deepEqual(pauses, [250, 500, 1000]);
  assert.equal(out.lockWaits.codes.BOARD_BUSY, 3);
});
