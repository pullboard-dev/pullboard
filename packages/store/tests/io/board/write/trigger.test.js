/** @pullboard-test-input source-cell store */
/** A move that also lifts an infra hold hands its own event row, not the chained unhold row, to its trigger consumers [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { appendFact, claim, getItem, insertShout, register, release, addItem } from '../../../../index.js';
import { INFRA_RELEASE_ENGINE } from '../../../../../state/index.js';
import { cellBoard } from '../../../fixtures/cell.js';

const COMMIT = 'a'.repeat(40);

/** A board whose one item holds the automatic "Released twice" hold from two infrastructure releases; the next write lifts it. */
function heldBoard(t) {
  const board = cellBoard(t, ':memory:');
  register(board, { lane: 'coordinator', path: '/repo' });
  board.executionEngineVersion = INFRA_RELEASE_ENGINE - 1;
  const seats = ['/one', '/two'].map(path => register(board, { lane: 'core', path, route: 'strong' }));
  const id = addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'strong' });
  for (const agentId of seats) {
    claim(board, id, { agentId, lane: 'core', leaseMs: 7200000,
      freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit: COMMIT, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
    board.db.prepare('INSERT INTO event (event_at, event_by, event_kind, item_id, event_detail) VALUES (?,?,?,?,?)')
      .run(new Date().toISOString(), agentId, 'submit-handoff', id, JSON.stringify({ state: 'infrastructure', commit: COMMIT }));
    release(board, id, agentId, '', 'BLOCKED');
  }
  assert.match(getItem(board, id).item_hold_reason, /Released twice/u);
  delete board.executionEngineVersion;
  return { board, id, seat: seats[0] };
}

test('store.io-board-write-sequencer.exact-trigger: clause 1: [C7] a fact that also lifts an infra hold returns and consumes its own fact row, not the chained unhold_item row', t => {
  const { board, id } = heldBoard(t);
  const result = appendFact(board, id, { agentId: 'coordinator', kind: 'note', text: 'check again', factId: 'exact-trigger-fact' });
  assert.equal(getItem(board, id).item_hold_reason, null, 'the same write lifted the hold');
  const own = board.db.prepare("SELECT event_id FROM event WHERE item_id = ? AND event_kind = 'fact'").get(id);
  assert.equal(result.id, 'exact-trigger-fact');
  assert.equal(result.eventId, own.event_id);
  assert.equal(result.kind, 'note');
});

test('store.io-board-write-sequencer.exact-trigger-shout: clause 1: [C7] a coordinator shout that also lifts an infra hold hands its own shout row to the rigor drafts, not the unhold_item row', t => {
  const { board, id } = heldBoard(t);
  const seen = [];
  board.nativePorts = { ...board.nativePorts, recordAutomaticRigorDrafts: (_board, trigger) => seen.push(trigger) };
  insertShout(board, { from: 'coordinator', to: 'all', text: 'look again', detail: { item: id } });
  assert.equal(getItem(board, id).item_hold_reason, null, 'the same write lifted the hold');
  assert.deepEqual(seen.map(row => row.event_kind), ['shout']);
});
