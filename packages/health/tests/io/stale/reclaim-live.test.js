/** With moves.live.reclaim on, stale-state maintenance refuses what the reclaim table refuses and writes the events it decides; unset, the writer's own decision stands and the table only shadows [C7,#9374]. */
/** @pullboard-test-input source-cell store board moves */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { logEvent } from '../../../../store/index.js';
import { maintainStaleState } from '../../../../store/index.js';
import { readShadow } from '../../../../store/index.js';
import { staleStateLimits } from '../../../../store/index.js';
import { fixtureBoard } from '../../../../board/tests/fixtures/board.js';

const AT = Date.parse('2026-11-16T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();

/** A board with a quiet seat holding item 7 and a helper seat to run maintenance; `live` stands in for moves.live.reclaim, `shadow` for moves.shadow. */
function quietSeat(t, { live, shadow, tamper } = {}) {
  const board = fixtureBoard(t, { clock: { now: () => new Date(AT) } });
  if (live !== undefined) board.movesLive = { reclaim: live };
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
    claims: [{ id: 7, actor: 'core-1', idle: 'seat-gone', claimEventId, claimAt: STAMP, deadSeat: { observedAt: STAMP, quietMs: tamper ?? 120_000, heartbeatAt: null, worktreeMissing: true } }] } });
  return { board, pass };
}

/** The item's state and its release events as the board holds them, minus the model stamp. */
function after(board) {
  const item = board.db.prepare('SELECT item_status s, item_owner o, item_lease_until l FROM item WHERE item_id=7').get();
  const events = board.db.prepare("SELECT event_kind kind, event_by by, event_detail detail FROM event WHERE item_id=7 AND event_kind IN ('release','fact','claim_stalled') ORDER BY event_id").all()
    .map(({ kind, by, detail }) => { const { model, ...rest } = JSON.parse(detail); return { kind, by, detail: rest }; });
  return { item: { ...item }, events };
}

test('health.reclaim-live.table-releases: clause 1: with moves.live.reclaim on, a pass over a quiet seat releases exactly the item and events the table names, the board the setting off leaves [C7,#9374]', t => {
  const off = quietSeat(t, { live: false });
  off.pass();
  const on = quietSeat(t, { live: true });
  const result = on.pass();
  assert.deepEqual(result.claims, [7]);
  assert.equal(after(on.board).item.s, 'open');
  assert.equal(after(on.board).events.length, 1, 'one release event');
  assert.equal(after(on.board).events[0].detail.idleClaim.kind, 'seat-gone');
  assert.deepEqual(after(on.board), after(off.board), 'the board after equals the board a pass with the setting off leaves');
});

test('health.reclaim-live.refusal-kept: clause 1: with moves.live.reclaim on, a row the table refuses is refused with the table\'s code and changes nothing [C7,#9374]', t => {
  const { board, pass } = quietSeat(t, { live: true, tamper: 60_000 });
  const before = after(board);
  assert.throws(pass, error => error.code === 'BAD_STALE_STATE' || error.code === 'STALE_STATE_CHANGED');
  assert.deepEqual(after(board), before, 'a refused pass writes nothing');
});

test('health.reclaim-live.unset-shadow-only: clause 2: with moves.live.reclaim set false, the writer\'s own decision stands and the table runs only as the shadow compare [C7,#9374]', t => {
  const { board, pass } = quietSeat(t, { live: false, shadow: true });
  const result = pass();
  assert.deepEqual(result.claims, [7], 'the writer released the item');
  const shadow = readShadow(board, 'reclaim');
  assert.equal(shadow?.compared, 1, 'the table ran as a compare');
  assert.equal(shadow.disagreed, 0, JSON.stringify(shadow.last));
});
