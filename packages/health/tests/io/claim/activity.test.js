/** The board read carries each claim's stalled, waiting and handoff state without turning missing evidence into idle time [B4,C7,#3039]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { openCellBoard as openBoard } from '../../../../board/tests/fixtures/cell-board.js';
import {
  claimHealthProjection,
  claimHealthSnapshot,
} from '../../../index.js';

const MINUTE = 60_000;

test('health.activity.claim-health-states: claim health carries building, stalled, waiting and unknown-idle claims from the board read [B4,C7,#3039]', t => {
  const at = Date.UTC(2026, 10, 6, 12, 0, 0);
  const board = openBoard(':memory:', { now: () => new Date(at) });
  t.after(() => store.closeBoard(board));
  const freeze = item => ({ text: item.item_title, digest: `private:${item.item_title}` });
  const claimed = title => {
    const id = store.addItem(board, { by: 'coordinator', lane: 'web', title });
    const agentId = store.register(board, { lane: 'web', path: `/nowhere/${title}` });
    store.claim(board, id, { agentId, lane: 'web', leaseMs: 120 * MINUTE, freeze });
    return id;
  };
  const building = claimed('building');
  const stalled = claimed('stalled');
  const unknown = claimed('unknown');
  const waiting = claimed('waiting');
  board.db.prepare('UPDATE item SET item_after=? WHERE item_id=?').run(String(building), waiting);
  const now = at + 60 * MINUTE;
  const observations = new Map([[building, now - 2 * MINUTE], [stalled, at + 10 * MINUTE]]);
  const health = claimHealthSnapshot(board, {}, new Date(now), {
    workObservation: (_actor, item) => observations.has(item.item_id) ? { available: true, at: new Date(observations.get(item.item_id)).toISOString() } : { available: false, at: null },
  });
  assert.equal(health.get(building).state, 'building');
  assert.equal(health.get(stalled).state, 'stalled');
  assert.ok(health.get(stalled).idleMinutes >= 40);
  assert.equal(health.get(unknown).idleMinutes, null, 'absent work evidence is never idle time');
  assert.equal(health.get(waiting).state, 'waiting');
  assert.deepEqual(health.get(waiting).waitingOn, [building]);
  assert.equal(health.size, 4);
});

test('health.activity.snapshot-projection: the projection reads a snapshot row into state, idle minutes, waiting ids and handoff pin [B4,C7,#3039]', () => {
  const rows = claimHealthProjection({ claims: [{ id: 7, health: 'stalled', idleMs: 25 * MINUTE + 5, handoff: { pin: 'refs/pullboard/h' } }, { id: 8, health: 'building', idleMs: NaN }] });
  assert.deepEqual(rows.get(7), { state: 'stalled', idleMinutes: 25, waitingOn: [], handoffRef: 'refs/pullboard/h' });
  assert.deepEqual(rows.get(8), { state: 'building', idleMinutes: null, waitingOn: [], handoffRef: null });
});
