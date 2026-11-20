/** relandAccepted returns a landing-reopened item to verified through the reland move MOVES declares, and refuses without the coordinator or the accept's proof note [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../index.js';
import { MOVES } from '../../../../state/index.js';
import { COORDINATOR } from '../../../../config/index.js';
import { cellBoard } from '../../fixtures/cell.js';

const AT = Date.parse('2026-11-18T12:00:00.000Z');
const STAMP = new Date(AT).toISOString();
const [COMMIT, MAIN] = ['a'.repeat(40), 'b'.repeat(40)];
const DIGEST = 'd'.repeat(64);

/** A board with item 7 open again after a landing failure, its own accept (with `note`) and green gate still at its head. */
function reopened(t, note) {
  const board = cellBoard(t, ':memory:', { now: () => new Date(AT) });
  const sql = board.db;
  for (const [id, lane] of [['core-1', 'core'], ['core-2', 'core']]) {
    sql.prepare('INSERT INTO agent (agent_id, agent_lane, agent_path, agent_route, agent_created_at) VALUES (?, ?, ?, ?, ?)').run(id, lane, `/seat/${id}`, 'strong', STAMP);
  }
  sql.prepare("INSERT INTO item (item_id, item_lane, item_title, item_route, item_status, item_created_by, item_created_at, item_updated_at) VALUES (7, 'core', 'landed', 'strong', 'open', 'coordinator', ?, ?)").run(STAMP, STAMP);
  const walk = (state, fields) => {
    const all = { ...fields, item_status: state };
    sql.prepare(`UPDATE item SET ${Object.keys(all).map(key => `${key}=?`).join(', ')} WHERE item_id=7`).run(...Object.values(all));
  };
  const event = (by, kind, detail) => sql.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?, ?, ?, 7, ?)').run(STAMP, by, kind, JSON.stringify(detail));
  sql.exec('INSERT INTO temp.moving VALUES (1)');
  walk('claimed', { item_owner: 'core-1', item_lease_until: '2099-01-01T00:00:00.000Z', item_frozen_digest: DIGEST, item_frozen: JSON.stringify({ criterion: 'x' }) });
  walk('submitted', { item_built_by: 'core-1', item_commit: COMMIT });
  event('core-1', 'submit', { commit: COMMIT, criterionDigest: DIGEST, gateGreen: true });
  sql.prepare('INSERT INTO verdict (item_id, verdict_by, verdict_decision, verdict_reason, verdict_note, verdict_commit, verdict_digest, verdict_head, verdict_at) VALUES (7, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run('core-2', 'ACCEPT', 'ACCEPT', note, COMMIT, DIGEST, COMMIT, STAMP);
  event('core-2', 'accept', { commit: COMMIT });
  walk('open', { item_owner: null, item_lease_until: null });
  event(COORDINATOR, 'reopen', { landingFailure: 'red on main', commit: COMMIT });
  sql.exec('DELETE FROM temp.moving');
  return board;
}

/** The refusal code a reland attempt throws, or null when it moves. */
function refusal(board, agentId) {
  try { store.relandAccepted(board, 7, { agentId, main: MAIN }); return null; } catch (error) { return error.code; }
}

test('store.logic-board-reland.the-reland-move-is-declared-in: clause 1: MOVES declares reland from open to verified for the coordinator with the coordinatorOnly and proofNoted guards, so relandAccepted names no transition of its own [C7]', () => {
  const move = MOVES.find(candidate => candidate.verb === 'reland');
  assert.deepEqual([move.from, move.to, move.by], [['open'], 'verified', ['coordinator']]);
  assert.ok(move.guards.includes('coordinatorOnly') && move.guards.includes('proofNoted'));
});

test('store.logic-board-reland.a-caller-who-is-not-the: clause 1: a caller who is not the coordinator is refused COORDINATOR_ONLY and the item stays open [C7]', t => {
  const board = reopened(t, 'run abc green');
  assert.equal(refusal(board, 'core-2'), 'COORDINATOR_ONLY');
  assert.equal(store.getItem(board, 7).item_status, 'open');
});

test('store.logic-board-reland.an-accept-that-records-no-proof: clause 1: an accept that records no proof note is refused PROOF_REQUIRED and the item stays open [C7]', t => {
  const board = reopened(t, '');
  assert.equal(refusal(board, COORDINATOR), 'PROOF_REQUIRED');
  assert.equal(store.getItem(board, 7).item_status, 'open');
});

test('store.logic-board-reland.an-eligible-item-whose-accept-carries: clause 2: an eligible item whose accept carries a proof note returns to verified for the coordinator [C7]', t => {
  const board = reopened(t, 'run abc green');
  assert.equal(refusal(board, COORDINATOR), null);
  const item = store.getItem(board, 7);
  assert.deepEqual([item.item_status, item.item_verified_by, item.item_commit], ['verified', 'core-2', COMMIT]);
});
