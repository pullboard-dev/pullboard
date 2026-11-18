/** A cold state build takes proof stats from the stored counters, not from the whole events table [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../index.js';
import { stateProofStats } from '../index.js';
import { proofStats } from '../../stats/index.js';
import { clearProofCounters } from '../../verify/index.js';
import { currentProofCounters } from '../../verify/index.js';
import { counterProofStats } from '../../verify/index.js';
import { fixtureBoard } from '../../board/tests/fixtures/board.js';

// fixture-subject: addItem (a store unit test of the state build's proof stats over seeded items)
/** A board with a few moves whose proof counters have been cleared, as on a board that carries none. */
function coldBoard(t) {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/repo' });
  store.register(board, { lane: 'web', path: '/repo-web-1' });
  for (const title of ['One', 'Two', 'Three']) store.addItem(board, { by: 'coordinator', lane: 'web', title, criterion: `${title} works` });
  clearProofCounters(board);
  return board;
}

test('store.state-proof-stats.a-state-build-on-a-board: clause 1: a state build on a board with no counters takes proof stats from the counters without reading every event [C7]', (t) => {
  const board = coldBoard(t);
  {
    assert.equal(currentProofCounters(board), null, 'the board starts with no current counters');
    const wanted = proofStats(board, { now: 5 }, { events: store.events, counterProofStats });
    clearProofCounters(board);
    let reads = 0;
    const events = () => { reads += 1; return store.events(board); };
    const got = stateProofStats(board, 5, { events, counterProofStats });
    assert.equal(reads, 0, 'the events table was not read');
    assert.ok(currentProofCounters(board), 'the counters are current after the build');
    assert.deepEqual(got, wanted, 'the numbers match the full read');
  }
});
