/** Receiver-side draft omissions use native decision and freeze history, without Git [S1,V2,H16]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import * as store from '../../../packages/store/index.js';
import { applyRelayMove } from '../../../packages/state/index.js';
import { prepareEngineMove } from '../../../packages/state/index.js';
import { exportBoard } from '../../../packages/store/index.js';
import { importBoard } from '../../../packages/store/index.js';
import { SPEC_DRAFT_REFREEZE_ENGINE } from '../../../packages/state/light.js';
import { rowDecisions } from '../../../packages/spec/index.js';
import { prepareSpecRefreezes } from '../../../packages/spec/index.js';
import { specRefreezeSkips } from '../../../packages/spec/index.js';
import { fixtureBoard } from '../../cli/tests/fixtures/board.js';

/** Native fixture bars model stored claim state; they are not executed checks or reviewer assurance. */
function frozen(item, text = 'The corrected promise.') {
  const value = JSON.stringify({ title: item.item_title, criterion: item.item_criterion, check: item.item_check,
    rows: item.item_spec_ids.split(',').map(id => ({ id, text: id === 'G1' ? text : 'The draft promise.', gate: 'true' })) });
  return { text: value, digest: createHash('sha256').update(value).digest('hex') };
}

/** Seed real SQLite transitions and person decision records for a mixed approval and draft decline. */
function setup(t) {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/draft-refreeze/root' });
  const builder = store.register(board, { lane: 'web', path: '/draft-refreeze/web' });
  const add = (title, specIds) => store.addItem(board, { by: 'coordinator', lane: 'web', title,
    criterion: 'The item satisfies its cited promises.', check: 'true', specIds });
  const left = add('Unfrozen draft citation', ['G1', 'G2']);
  const right = add('Another unfrozen draft citation', ['G1', 'G2']);
  const ordinary = add('Only approved citations', ['G1']);
  const claimed = add('Existing frozen work', ['G1']);
  store.claim(board, claimed, { agentId: builder, lane: 'web', leaseMs: 3_600_000,
    freeze: item => frozen(item, 'The original promise.') });
  const on = board.clock.now().toISOString();
  const base = { version: 1, type: 'row-decision', kind: 'spec', file: 'SPEC.md', by: 'person', on, commit: '', note: '' };
  store.recordRowDecisions(board, { agentId: 'person', channel: 'terminal', decisions: [
    { ...base, id: 'G1', source: '- G1 [approved, must] The original promise. | gate: true',
      replacement: '- G1 [approved, must] The corrected promise. | gate: true',
      text: 'The corrected promise.', decision: 'approve', reason: '' },
    { ...base, id: 'G2', source: '- G2 [draft, must] The draft promise. | gate: true',
      replacement: '- G2 [wont, must] The draft promise. | gate: true',
      text: 'The draft promise.', decision: 'decline', reason: 'The draft is not needed.' },
  ] });
  const records = rowDecisions(board), items = store.listItems(board, { all: true });
  const skippedDrafts = specRefreezeSkips(board, records, items);
  assert.deepEqual(skippedDrafts, [left, right]);
  const refreezes = prepareSpecRefreezes(records, items, frozen, { skippedDrafts });
  assert.deepEqual(refreezes.map(entry => entry.itemId), [ordinary, claimed]);
  const move = prepareEngineMove(board, 'applyRowDecisions', [{ agentId: 'coordinator',
    events: records.map(record => record.event), refreezes, skippedDrafts }], { id: 'draft-omission', actor: 'coordinator' });
  return { board, builder, left, right, ordinary, claimed, records, move, prefix: exportBoard(board) };
}

/** Replay on an independent production-schema receiver at the same native prefix. */
function receiver(t, prefix) {
  const board = fixtureBoard(t);
  importBoard(board, prefix);
  return board;
}

const order = { sequence: 1, at: '2026-10-27T00:00:00.000Z', kind: 'move',
  sender: { kind: 'agent', userId: 'fixture-user', agent: 'coordinator' } };

test('draft omissions replay identically while ordinary and frozen citations refreeze [S1,V2,H16]', t => {
  const box = setup(t), replica = receiver(t, box.prefix);
  const beforeClaim = store.getItem(replica, box.claimed);
  assert.ok(box.move.engine >= SPEC_DRAFT_REFREEZE_ENGINE, 'the move carries at least the draft refreeze engine');
  const local = applyRelayMove(box.board, box.move, order);
  assert.equal(local.error, undefined, JSON.stringify(local));
  assert.deepEqual(applyRelayMove(replica, box.move, order), local);
  assert.deepEqual(exportBoard(replica), exportBoard(box.board));
  for (const id of [box.left, box.right]) {
    const item = store.getItem(replica, id);
    assert.equal(item.item_status, 'open');
    assert.equal(item.item_frozen, null);
    assert.equal(item.item_spec_ids, 'G1,G2', 'omission grants no citation edit');
  }
  for (const id of [box.ordinary, box.claimed]) assert.match(store.getItem(replica, id).item_frozen, /The corrected promise\./u);
  assert.equal(store.getItem(replica, box.claimed).item_lease_until, beforeClaim.item_lease_until);
  assert.equal(store.getItem(replica, box.claimed).item_owner, beforeClaim.item_owner);
  const after = exportBoard(replica);
  assert.deepEqual(applyRelayMove(replica, box.move, order), local);
  assert.deepEqual(exportBoard(replica), after, 'a duplicate neither refreezes nor notifies twice');
});

test('draft omission replay refuses forged stale and old-engine omissions without domain mutation [V2,H16]', t => {
  const box = setup(t);
  const mutations = [
    move => { delete move.args[0].skippedDrafts; },
    move => { move.args[0].skippedDrafts = [box.left]; },
    move => { move.args[0].skippedDrafts = [box.right, box.left]; },
    move => { move.args[0].skippedDrafts = [box.left, box.left]; },
    move => { move.args[0].skippedDrafts.push(box.ordinary); },
  ];
  for (const mutate of mutations) {
    const board = receiver(t, box.prefix), move = structuredClone(box.move);
    mutate(move);
    const items = store.listItems(board, { all: true }), decisions = rowDecisions(board);
    const result = applyRelayMove(board, move, order);
    assert.ok(['STALE_ROW_DECISION', 'ENGINE_VERSION'].includes(result.error?.code), JSON.stringify(result));
    assert.deepEqual(store.listItems(board, { all: true }), items);
    assert.deepEqual(rowDecisions(board), decisions);
  }
  const old = receiver(t, box.prefix), oldMove = structuredClone(box.move);
  oldMove.engine = SPEC_DRAFT_REFREEZE_ENGINE - 1;
  const beforeOld = exportBoard(old);
  assert.throws(() => applyRelayMove(old, oldMove, order), error => error.code === 'RELAY_MOVE'
    && error.message.includes(`introduced in engine ${SPEC_DRAFT_REFREEZE_ENGINE}`));
  assert.deepEqual(exportBoard(old), beforeOld, 'old-engine frames refuse before recording or interpreting the move');
  const changed = receiver(t, box.prefix);
  const other = store.register(changed, { lane: 'web', path: '/draft-refreeze/other' });
  store.claim(changed, box.left, { agentId: other, lane: 'web', leaseMs: 3_600_000, freeze: frozen });
  assert.equal(applyRelayMove(changed, box.move, order).error?.code, 'STALE_ROW_DECISION');
  store.release(changed, box.left, other, 'Release the modeled claim.', 'OTHER');
  store.editItem(changed, box.left, { agentId: 'coordinator', criterion: 'A revised fixture promise.', reason: 'Revise the open fixture.' });
  assert.equal(store.getItem(changed, box.left).item_frozen, null, 'an edited open item can lose its current frozen payload');
  assert.deepEqual(specRefreezeSkips(changed, box.records, store.listItems(changed, { all: true })), [box.right],
    'lifetime claim history prevents treating a previously frozen item as never frozen');
});
