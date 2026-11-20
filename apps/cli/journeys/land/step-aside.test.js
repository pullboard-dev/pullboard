/** @pullboard-test-input source-cell apps/cli */
/** A head item that fails twice on infrastructure steps aside, and the next accepted item lands [C7,#3118]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidates } from '../../../../packages/landing/index.js';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { makeMergeBoard } from '../../tests/fixtures/land/merge-board.js';

/** Item ids the selection offers, in the order it offers them. */
const ready = (board, root, base, options = {}) => candidates(board, root, base, 8, options).ready.map(item => item.item_id);

test('cli.journeys-land-step-aside.next-accepted-item-lands-after-head-fails-twice: after the head fails twice on infrastructure the next accepted item lands, and the head keeps its accept and lands after it [C7,#3118]', t => {
  const e2e = createE2eHelpers();
  t.after(e2e.cleanup);
  const { boardFixture, accepted } = makeMergeBoard(e2e);
  const box = boardFixture();
  const head = accepted(box, 1, { 'docs/one.md': '# One\n' });
  const next = accepted(box, 2, { 'docs/two.md': '# Two\n' });
  const on = action => onBoard(box, action);
  const base = () => box.git(box.repo, 'rev-parse', 'HEAD').trim();
  const accepts = id => on(board => board.db.prepare("SELECT count(*) AS n FROM event WHERE event_kind='accept' AND item_id=?").get(id).n);
  const order = options => on(board => ready(board, box.repo, base(), options));

  assert.deepEqual(order({ stepAside: 2 }), [head, next], 'both are accepted and the head leads');
  on(board => store.countLeaseLapse(board, head));
  assert.deepEqual(order({ stepAside: 2 }), [head, next], 'one infrastructure failure keeps the head in front');
  on(board => store.countLeaseLapse(board, head));
  assert.deepEqual(order({ stepAside: 2 }), [next, head], 'two failures put the next accepted item in front');
  assert.deepEqual(order(), [head, next], 'with the step-aside count off the accept order stays');

  // The next item lands: its real commit is merged into trunk and the board records the landing.
  const tip = on(board => store.getItem(board, next).item_commit);
  box.git(box.repo, 'merge', '-q', '--no-ff', '-m', `Merge #${next} onto main`, tip);
  const landed = base();
  on(board => store.merged(board, next, { agentId: 'coordinator', commit: landed }));
  assert.equal(on(board => store.getItem(board, next).item_merged_commit), landed, 'the next item is recorded as landed');
  assert.equal(on(board => store.getItem(board, head).item_status), 'verified', 'the stepped-aside head is still accepted');
  assert.equal(on(board => store.getItem(board, head).item_merged_commit), null, 'and not landed yet');
  assert.equal(accepts(head), 1, 'its accept is untouched');
  assert.deepEqual(order({ stepAside: 2 }), [head], 'it is still offered, alone now');
});
