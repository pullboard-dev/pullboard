/** @pullboard-test-input source-tree */
/** Private real-Git/SQLite lifecycle controls; none of these records claims a gate or publication. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import * as store from '../../../src/board.js';
import { openBoard } from '../../../apps/lib/index.js';
import {
  appliedSequence,
  applyEngineMove,
  prepareEngineMove,
} from '../src/shell/engine.js';
import { submitFixture } from '../../../test/board-submit-fixture.js';
import { FILE_GROWTH_NOTICE_ENGINE } from '../../../src/file-growth-notice-engine.js';
import {
  exportBoard,
  importBoard,
} from '../../store/index.js';
import { createE2eHelpers } from '../../../test/e2e-helpers.js';

const HOUR = 60 * 60 * 1000;
/** Seed only private claim state, using a real project and its normal board file. */
function fixture(t, { sameHolder = false, expiredPeer = false } = {}) {
  const helpers = createE2eHelpers();
  let board;
  t.after(() => { if (board) store.closeBoard(board); helpers.cleanup(); });
  const box = helpers.project('true');
  board = openBoard(join(box.repo, '.git', 'pullboard', 'board.sqlite'));
  // This is a board-clock boundary control, not an actual physical lease or elapsed-time claim.
  let at = Date.parse('2026-10-24T00:00:00Z');
  board.clock = { now: () => new Date(at) };
  const left = store.register(board, { lane: 'web', path: join(box.dir, 'left-state'), route: 'strong' });
  const right = sameHolder ? left : store.register(board, { lane: 'web', path: join(box.dir, 'right-state'), route: 'strong' });
  /** Keep each fixture's frozen words explicit without claiming a check was executed. */
  const freeze = item => ({ text: JSON.stringify({ title: item.item_title, criterion: 'private lifecycle state', check: 'true', rows: [] }), digest: `fixture:${item.item_id}` });
  const a = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'A holds x', brief: 'Files: web/x.js' });
  const b = store.addItem(board, { by: 'coordinator', lane: 'web', title: 'B holds y', brief: 'Files: web/y.js' });
  store.claim(board, a, { agentId: left, lane: 'web', leaseMs: HOUR, freeze });
  if (sameHolder) submitFixture(board, a, { agentId: left,
    commit: box.git(box.repo, 'rev-parse', 'HEAD'), tree: box.git(box.repo, 'rev-parse', 'HEAD^{tree}') });
  if (expiredPeer) at += HOUR;
  store.claim(board, b, { agentId: right, lane: 'web', leaseMs: HOUR, freeze });
  return { board, left, right, a, b, at: () => new Date(at).toISOString() };
}

/** Apply the ordinary versioned edit input, rather than calling a notification helper. */
function edit(box, brief, engine = undefined) {
  const move = prepareEngineMove(box.board, 'editItem', [box.b, { agentId: 'coordinator', brief }]);
  const result = applyEngineMove(box.board, engine === undefined ? move : { ...move, engine }, { sequence: appliedSequence(box.board) + 1, at: box.at() });
  assert.equal(result.error, undefined, JSON.stringify(result.error));
}

test('historical brief edits stay silent while current overlap notices survive board export [N2,B7,H16]', t => {
  const box = fixture(t);
  edit(box, 'Files: web/y.js, web/x.js', FILE_GROWTH_NOTICE_ENGINE - 1);
  assert.match(store.getItem(box.board, box.b).item_brief, /web\/x\.js/u, 'legacy edit still takes effect');
  assert.equal(store.allShouts(box.board).length, 0, 'replaying an older edit does not invent new messages');
  edit(box, 'Files: web/y.js', FILE_GROWTH_NOTICE_ENGINE - 1);
  edit(box, 'Files: web/y.js, web/x.js');
  const notices = store.allShouts(box.board);
  assert.deepEqual(notices.map(row => row.shout_to).toSorted(), [box.left, box.right].toSorted());
  edit(box, 'Files: web/y.js, web/x.js');
  assert.equal(store.allShouts(box.board).length, 2, 'another edit with the same file set does not resend');
  const copy = openBoard(':memory:');
  t.after(() => store.closeBoard(copy));
  importBoard(copy, exportBoard(box.board));
  assert.deepEqual(store.allShouts(copy), notices, 'snapshot transport retains the actual delivered messages');
  for (const id of [box.a, box.b]) assert.deepEqual(store.itemThread(copy, id), store.itemThread(box.board, id));
});

test('one holder of both overlapping items gets one message linked to both threads [N2,B7,B13]', t => {
  const box = fixture(t, { sameHolder: true });
  edit(box, 'Files: web/y.js, web/x.js');
  const notices = store.allShouts(box.board);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].shout_to, box.left);
  for (const id of [box.a, box.b]) assert.ok(store.itemThread(box.board, id)
    .some(event => event.kind === 'shout' && event.detail.shout === notices[0].shout_id));
});

test('a brief growth does not notify an expired claim as work in flight [N2,B4,N20]', t => {
  const box = fixture(t, { expiredPeer: true });
  assert.equal(store.getItem(box.board, box.a).item_status, 'open', 'the existing lease boundary is respected');
  edit(box, 'Files: web/y.js, web/x.js');
  assert.match(store.getItem(box.board, box.b).item_brief, /web\/x\.js/u);
  assert.equal(store.allShouts(box.board).length, 0);
});
