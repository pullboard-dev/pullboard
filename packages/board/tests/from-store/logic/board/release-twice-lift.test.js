/** release.liftTwiceHold: an automatic released-twice hold lifts when main moves or its named blocker lands [C7,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { openCellBoard as openBoard } from '../../../fixtures/cell-board.js';

// fixture-subject: addItem (a store unit test of the release-twice hold over two seats' releases; the board is opened through the cell fixture)

const commit = 'a'.repeat(40);

/** A board with a blocker item and a worked item that two seats released, so the release-twice hold is on it; `named` makes the second release name the blocker. */
function held(t, { lift, named = false }) {
  const board = openBoard(':memory:');
  t.after(() => store.closeBoard(board));
  store.register(board, { lane: 'coordinator', path: '/repo' });
  const first = store.register(board, { lane: 'core', path: '/one', route: 'strong' });
  const second = store.register(board, { lane: 'core', path: '/two', route: 'strong' });
  const blocker = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'blocker', criterion: 'prove it', route: 'strong' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'work', criterion: 'prove it', route: 'strong' });
  if (lift) board.liftTwiceHold = true;
  const claim = agentId => store.claim(board, id, { agentId, lane: 'core', leaseMs: 7200000,
    freeze: item => ({ text: JSON.stringify({ criterion: item.item_criterion, policy: { version: 1, commit, verify: { policy: 'any', family: 'off' } } }), digest: 'digest' }) });
  claim(first); store.release(board, id, first, '', 'BLOCKED');
  // A release naming --on no longer counts toward the twice (#9722), so the named blocker sits in the history as the record an older board holds, between the two counted releases.
  if (named) write(board, 'release', id, { reasonCode: 'BLOCKED', blockedOn: [blocker] });
  claim(second);
  store.release(board, id, second, '', 'BLOCKED');
  return { board, id, blocker };
}

/** Record a native event as the coordinator's board write. */
function write(board, kind, item, detail = {}) {
  store.atomic(board, () => store.logEvent(board, 'coordinator', kind, item, detail));
}

/** Whether the item still carries the release-twice hold. */
const holding = (board, id) => /Released twice/u.test(store.getItem(board, id).item_hold_reason ?? '');

test('clause 1: with release.liftTwiceHold off, a released-twice hold stays after main moves [C7,H16]', t => {
  const f = held(t, { lift: false });
  assert.ok(holding(f.board, f.id), 'two releases held the item');
  write(f.board, 'main-moved', null, { sha: 'b'.repeat(40), batch: 'b1', items: [] });
  write(f.board, 'merged', f.blocker);
  assert.ok(holding(f.board, f.id), 'the hold stays');
});

test('clause 2: with release.liftTwiceHold on, an automatic released-twice hold lifts when main moves [C7,H16]', t => {
  const f = held(t, { lift: true });
  assert.ok(holding(f.board, f.id));
  write(f.board, 'shout', f.id);
  assert.ok(holding(f.board, f.id), 'an ordinary write does not lift it');
  write(f.board, 'main-moved', null, { sha: 'b'.repeat(40), batch: 'b1', items: [] });
  assert.equal(store.getItem(f.board, f.id).item_hold_reason, null);
  assert.ok(f.board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='unhold_item' AND event_detail LIKE '%main-moved%'").get(f.id));
});

test('clause 2: a hold the coordinator placed by hand is not lifted when main moves [C7,H16]', t => {
  const f = held(t, { lift: true });
  store.releaseItemHold(f.board, f.id, { agentId: 'coordinator', reason: 'lifted by hand' });
  assert.equal(store.getItem(f.board, f.id).item_hold_reason, null);
  store.holdItem(f.board, f.id, { agentId: 'coordinator', reason: 'Released twice by my own decision' });
  write(f.board, 'main-moved', null, { sha: 'b'.repeat(40), batch: 'b1', items: [] });
  assert.match(store.getItem(f.board, f.id).item_hold_reason, /own decision/u);
});

test('clause 3: with release.liftTwiceHold on, a hold whose release names a blocker lifts when that item lands [C7,H16]', t => {
  const f = held(t, { lift: true, named: true });
  write(f.board, 'merged', f.id + 1000);
  assert.ok(holding(f.board, f.id), 'an unrelated landing does not lift it');
  write(f.board, 'merged', f.blocker);
  assert.equal(store.getItem(f.board, f.id).item_hold_reason, null);
  assert.ok(f.board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='unhold_item' AND event_detail LIKE '%blocker-landed%'").get(f.id));
});
