/** Withdrawal facts survive capped activity feeds in the shared native projection [A2,C15,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { projectItemState } from '../../../../packages/api/index.js';
import { itemSummary } from '../../../../packages/items/index.js';
import { withdrawnFrom } from '../../../../packages/items/index.js';
import { fixtureBoard } from '../../tests/fixtures/board.js';
import { apiHttpBox as httpBox } from '../../tests/fixtures/api.js';
import { openBoard } from '../../../lib/index.js';
import { closeBoard } from '../../../lib/index.js';
import { projectState } from '../../src/io/view.js';
import { join } from 'node:path';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { exportBoard } from '../../../../packages/store/index.js';
import { snapshotState } from '../../../relay/index.js';
import { presentationState } from '../../../relay/index.js';

/** Use actual board moves; synthetic submit proof is only a lifecycle input, not a gate claim. */
function fixture(t, clock) {
  const board = fixtureBoard(t, { clock });
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
  assert.equal(withdrawnFrom([{ kind: 'add' }, { kind: 'claim' }, { kind: 'withdraw', at: '2026-10-30T00:00:00Z' }], 'withdrawn'), null);
  assert.equal(withdrawnFrom([{ kind: 'add' }, { kind: 'claim', leaseUntil: 'invalid' }, { kind: 'withdraw', at: '2026-10-30T00:00:00Z' }], 'withdrawn'), null);
});

test('withdrawal uses the public stage at the recorded lease expiry boundary [A2,C15,N26]', t => {
  for (const offset of [-1, 0, 1]) {
    let now = Date.parse('2026-10-30T00:00:00Z');
    const f = fixture(t, { now: () => new Date(now) });
    f.claim();
    const deadline = store.getItem(f.board, f.id).item_lease_until;
    now = Date.parse(deadline) + offset;
    const expected = offset < 0 ? 'claimed' : 'open';
    assert.equal(store.getItem(f.board, f.id).item_status, expected, 'the public stage is authoritative, including equality');
    assert.equal(f.board.db.prepare('SELECT item_status FROM item WHERE item_id=?').get(f.id).item_status, 'claimed', 'the old writer row alone cannot prove the public stage');
    store.withdraw(f.board, f.id, { agentId: 'coordinator', reason: 'Use the public lifecycle stage' });
    const native = f.project();
    const hosted = snapshotState(exportBoard(f.board), store.boardId(f.board)).items[0];
    assert.equal(native.withdrawnFrom, expected);
    assert.equal(hosted.withdrawnFrom, expected);
    assert.equal(native.history.find(event => event.kind === 'claim').leaseUntil, deadline);
  }
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

test('withdrawal facts agree in HTTP summary, detail and sealed projection [A2,C15,N26]', async t => {
  const box = await httpBox(t);
  // @pullboard-board-file journey: HTTP and sealed readers must observe the same persisted withdrawal.
  const board = openBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'));
  let withdrawn;
  let open;
  try {
    withdrawn = store.addItem(board, { by: 'coordinator', lane: 'app', title: 'No longer needed' });
    open = store.addItem(board, { by: 'coordinator', lane: 'app', title: 'Still needed' });
    store.withdraw(board, withdrawn, { agentId: 'coordinator', reason: 'Replaced by the revised plan' });
  } finally { closeBoard(board); }
  const summary = await box.call(box.path + '/state');
  const sealed = projectState(box.root);
  for (const [id, reason, from] of [[withdrawn, 'Replaced by the revised plan', 'open'], [open, null, null]]) {
    const detail = await box.call(box.path + '/items/' + id);
    assert.equal(detail.status, 200);
    for (const item of [summary.document.state.items.find(item => item.id === id), detail.document.item, sealed.items.find(item => item.id === id)]) {
      assert.equal(item.withdrawnReason, reason);
      assert.equal(item.withdrawnFrom, from);
      assert.deepEqual(Object.keys(item).filter(key => key.startsWith('withdrawn')).sort(), ['withdrawnFrom', 'withdrawnReason']);
    }
  }
});

