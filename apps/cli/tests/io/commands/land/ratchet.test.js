import assert from 'node:assert/strict';
import { test } from 'node:test';
import { untilBoardFree } from '../../../../src/io/commands/land.js';
import { prepareFlakeLanding } from '../../../../../../packages/landing/index.js';
import { Refused } from '../../../../../../packages/kernel/index.js';

const STALE = 'flake evidence or repair status changed before the landing snapshot was recorded; retry the landing';

test('a stale flake-ratchet boundary is thrown to the worker at once; a held board still waits [C7]', async () => {
  const waits = [];
  const wait = ms => { waits.push(ms); return Promise.resolve(); };
  await assert.rejects(untilBoardFree(async () => { throw new Refused('BOARD_BUSY', STALE); }, { wait }), { code: 'BOARD_BUSY' });
  assert.deepEqual(waits, [], 'no sleep on a stale boundary');
  let calls = 0;
  const value = await untilBoardFree(async () => { if (++calls < 3) throw new Refused('BOARD_BUSY', 'board file x remained held by another process after 10ms'); return 'done'; }, { wait });
  assert.equal(value, 'done');
  assert.deepEqual(waits, [1000, 2000], 'a held board is retried with the backoff');
});

test('prepareFlakeLanding recomputes the snapshot when the board moved under it, and gives up after a bound [C7]', async () => {
  let boundary = 0;
  const written = [];
  const state = {
    board: {}, batch: {}, say: () => {},
    landingPorts: { landingFlakeRatchet: () => ({ allowed: true, snapshot: { version: 1, eventId: ++boundary, count: 0, quarantines: [] } }) },
    write: async (operation, [{ batch }]) => {
      written.push(batch.flakeRatchet.eventId);
      if (batch.flakeRatchet.eventId < 3) throw new Refused('BOARD_BUSY', STALE);
      return { ...state.batch, ...batch };
    },
  };
  const batch = await prepareFlakeLanding(state);
  assert.equal(batch.flakeRatchet.eventId, 3, 'the third, fresh boundary is accepted');
  assert.deepEqual(written, [1, 2, 3]);
  const stuck = { ...state, write: async () => { throw new Refused('BOARD_BUSY', STALE); } };
  await assert.rejects(prepareFlakeLanding(stuck), { code: 'BOARD_BUSY' });
});
