/** Withdrawal facts survive capped activity feeds in the shared native projection [A2,C15,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { projectItemState } from '../src/api.js';
import { itemSummary } from '../src/item-list.js';
import { withdrawnFrom } from '../src/item-list.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { exportBoard } from '../src/exchange.js';
import { snapshotState } from '../relay/browser-model.js';
import { presentationState } from '../relay/browser-model.js';

/** Use actual board moves; synthetic submit proof is only a lifecycle input, not a gate claim. */
function fixture(t) {
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/withdraw/root' });
  const builder = store.register(board, { lane: 'core', path: '/withdraw/builder', session: 'builder' });
  const id = store.addItem(board, { by: 'coordinator', lane: 'core', title: 'Withdrawal projection', criterion: 'Keep the reason' });
  const freeze = item => ({ text: item.item_criterion, digest: 'withdraw:' + item.item_criterion });
  const claim = () => store.claim(board, id, { agentId: builder, lane: 'core', leaseMs: 3_600_000, freeze, head: 'a'.repeat(40) });
  const project = () => {
    const row = store.getItem(board, id);
    return projectItemState(board, row, new Map([[id, row.item_status]]));
  };
  return { board, builder, id, claim, project, freeze };
}

test('withdrawn summary and detail keep the actual open, claimed or submitted origin [A2,C15,N26]', t => {
  for (const stage of ['open', 'claimed', 'submitted']) {
    const f = fixture(t);
    if (stage !== 'open') f.claim();
    if (stage === 'submitted') submitFixture(f.board, f.id, { agentId: f.builder, commit: 'b'.repeat(40), tree: 'b'.repeat(40) });
    store.withdraw(f.board, f.id, { agentId: 'coordinator', reason: '  Superseded by the new design  ' });
    for (let index = 0; index < 100; index += 1) store.appendFact(f.board, f.id, { agentId: 'coordinator', kind: 'note', text: 'Later history ' + index });
    assert.equal(store.recentEvents(f.board, 80).some(event => event.event_kind === 'withdraw'), false);
    const detail = f.project();
    const summary = itemSummary(detail);
    const legacy = snapshotState(exportBoard(f.board), store.boardId(f.board));
    const olderPresentation = structuredClone(legacy);
    for (const item of olderPresentation.items) { delete item.withdrawnReason; delete item.withdrawnFrom; }
    const presented = presentationState({ version: 1, state: olderPresentation }, store.boardId(f.board));
    for (const projected of [detail, summary, JSON.parse(JSON.stringify(summary)), legacy.items[0]]) {
      assert.equal(projected.withdrawnReason, 'Superseded by the new design');
      assert.equal(projected.withdrawnFrom, stage);
      assert.ok(Object.hasOwn(projected, 'withdrawnReason'));
      assert.ok(Object.hasOwn(projected, 'withdrawnFrom'));
    }
    assert.equal(presented.items[0].withdrawnReason, null, 'sanitized older presentation carries no authoritative reason to recover');
    assert.equal(presented.items[0].withdrawnFrom, stage, 'complete lifecycle history still proves the prior stage');
    assert.deepEqual(Object.keys(presented.items[0]).filter(key => key.startsWith('withdrawn')).sort(), ['withdrawnFrom', 'withdrawnReason']);
    assert.deepEqual(Object.keys(summary).filter(key => key.startsWith('withdrawn')), ['withdrawnReason', 'withdrawnFrom']);
  }
});

test('non-withdrawn items carry explicit null withdrawal facts [A2,C15,N26]', t => {
  const f = fixture(t);
  for (const claim of [false, true]) {
    if (claim) f.claim();
    const detail = f.project();
    for (const item of [detail, itemSummary(detail)]) {
      assert.equal(item.withdrawnReason, null);
      assert.equal(item.withdrawnFrom, null);
      assert.ok(Object.hasOwn(JSON.parse(JSON.stringify(item)), 'withdrawnFrom'));
    }
  }
});

test('withdrawal origin requires recorded history, never a guessed current stage [A2,C15,N26]', () => {
  assert.equal(withdrawnFrom([], 'withdrawn'), null);
  assert.equal(withdrawnFrom([{ kind: 'withdraw', at: '2026-10-30T00:00:00Z' }], 'withdrawn'), null);
  assert.equal(withdrawnFrom([{ kind: 'add' }, { kind: 'claim' }], 'withdrawn'), null);
  assert.equal(withdrawnFrom([{ kind: 'add' }, { kind: 'withdraw' }], 'open'), null);
  assert.equal(withdrawnFrom([{ kind: 'add' }, { kind: 'claim' }, { kind: 'lapse' }, { kind: 'withdraw' }], 'withdrawn'), 'open');
});

test('legacy hosted snapshots replay the same withdrawal lifecycle including retained refreezes [A2,C15,N26]', t => {
  const f = fixture(t);
  f.claim();
  store.editItem(f.board, f.id, { agentId: 'coordinator', criterion: 'Corrected promise', reason: 'Clarify the bar', freeze: f.freeze });
  assert.equal(store.refreeze(f.board, f.id, { agentId: 'coordinator', freeze: f.freeze }).retainedClaim, true);
  store.withdraw(f.board, f.id, { agentId: 'coordinator', reason: 'The replacement is ready' });
  const document = exportBoard(f.board);
  const boardId = store.boardId(f.board);
  const hosted = snapshotState(document, boardId).items.find(item => item.id === f.id);
  const native = f.project();
  for (const key of ['withdrawnReason', 'withdrawnFrom']) assert.equal(hosted[key], native[key]);
  assert.equal(hosted.withdrawnFrom, 'claimed');
  assert.equal(hosted.history.findLast(event => event.kind === 'refreeze').retainedClaim, true);
  assert.equal(hosted.history.some(event => Object.hasOwn(event, 'event_detail')), false);
  const malformed = structuredClone(document);
  malformed.tables.event.find(event => event.event_kind === 'refreeze').event_detail = '{';
  assert.throws(() => snapshotState(malformed, boardId), { code: 'RELAY_SNAPSHOT' });
});
