/** With moves.shadow on, stale-state maintenance runs the reclaim table beside its release and records the compare; off, it runs no table [C7,#9367]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logEvent } from '../../../../store/index.js';
import { maintainStaleState } from '../../../../store/index.js';
import { readShadow } from '../../../../store/index.js';
import { staleStateLimits } from '../../../../store/index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';

const AT = Date.parse('2026-11-16T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();

/** A board with a quiet seat holding item 7 and a helper seat to run maintenance; `shadow` stands in for the moves.shadow machine setting. */
function quietSeat(t, shadow) {
  const board = fixtureBoard(t, { clock: { now: () => new Date(AT) } });
  if (shadow !== undefined) board.movesShadow = shadow;
  const sql = board.db;
  for (const id of ['core-1', 'core-2']) {
    sql.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(id, 'core', `/seat/${id}`, 'strong', STAMP);
  }
  sql.prepare(`INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'held', 'strong', 'open', 'coordinator', ?, ?)`).run(STAMP, STAMP);
  sql.exec('INSERT INTO temp.moving VALUES (1)');
  sql.prepare("UPDATE item SET item_status='claimed', item_owner='core-1', item_lease_until='2099-01-01T00:00:00.000Z', item_frozen_digest=? WHERE item_id=7").run('d'.repeat(64));
  sql.exec('DELETE FROM temp.moving');
  logEvent(board, 'core-1', 'claim', 7, { leaseUntil: '2099-01-01T00:00:00.000Z' });
  const claimEventId = sql.prepare("SELECT MAX(event_id) id FROM event WHERE event_kind='claim' AND item_id=7").get().id;
  /** One maintenance pass that returns the quiet seat's claim because its worktree is gone. */
  const pass = () => maintainStaleState(board, { agentId: 'core-2', claimsOnly: true, snapshot: {
    observedAt: STAMP, observedRevision: sql.prepare('SELECT COALESCE(MAX(event_id),0) id FROM event').get().id, holds: [], reviews: [],
    limits: staleStateLimits({}, { dependency: true }), claimScan: { previous: 0, next: 1 },
    claims: [{ id: 7, actor: 'core-1', idle: 'seat-gone', claimEventId, claimAt: STAMP, deadSeat: { observedAt: STAMP, quietMs: 120_000, heartbeatAt: null, worktreeMissing: true } }] } });
  return { board, pass };
}

test('health.reclaim-shadow.records-compare: clause 1: with moves.shadow on, a pass that releases a quiet seat records one reclaim compare that agrees with the release it wrote [C7,#9367]', t => {
  const { board, pass } = quietSeat(t, true);
  const result = pass();
  assert.deepEqual(result.claims, [7], 'maintenance released the quiet seat\'s item');
  assert.equal(board.db.prepare('SELECT item_status s FROM item WHERE item_id=7').get().s, 'open');
  const shadow = readShadow(board, 'reclaim');
  assert.equal(shadow?.compared, 1, 'one compare was recorded under table reclaim');
  assert.equal(shadow.disagreed, 0, JSON.stringify(shadow.last));
});

test('health.reclaim-shadow.off-records-nothing: clause 2: with moves.shadow off, a pass runs no reclaim table and records nothing [C7,#9367]', t => {
  const { board, pass } = quietSeat(t, false);
  const result = pass();
  assert.deepEqual(result.claims, [7], 'maintenance still released the item');
  assert.equal(readShadow(board, 'reclaim'), null, 'nothing was recorded');
});
