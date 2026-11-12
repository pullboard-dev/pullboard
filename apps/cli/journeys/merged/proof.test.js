/** merged --forced names its proof: a tip with no receipt is refused, and a receipt rides on the merged event [C7,#4742]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { submitFixture } from '../../tests/fixtures/board/submit.js';
import { cellBoard } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellClaim } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellItem } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../packages/store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../packages/store/tests/fixtures/cell.js';

const TIP = '7'.repeat(40);
const LANDED = '8'.repeat(40);

/** A real project and board with one core item claimed and submitted at TIP, with no receipt yet. */
function submittedItem(t) {
  const project = cellProject(t);
  const board = cellBoard(t, project.boardFile, { now: () => new Date() }, { gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'core', path: project.repo });
  const id = cellItem(board, { lane: 'core', title: 'Forced proof fixture', route: 'strong', criterion: 'the fixture works' }).item_id;
  cellClaim(board, id, seat, { root: project.repo, itemFolder: true });
  submitFixture(board, id, { agentId: seat.id, commit: TIP, tree: TIP });
  return { board, builder: seat.id, id };
}

/** The merged events of one item, parsed. */
function merges(board, id) {
  return board.db.prepare("SELECT event_detail FROM event WHERE item_id = ? AND event_kind = 'merged'").all(id).map(row => JSON.parse(row.event_detail));
}

test('clause 1: merged --forced with no receipt for the tip is refused with a rule code and next step [C7,#4742]', t => {
  const { board, id } = submittedItem(t);
  assert.throws(() => store.merged(board, id, { agentId: 'coordinator', commit: LANDED, forced: 'landed by hand' }),
    error => error.code === 'FORCED_NO_PROOF' && /--waive-proof/u.test(error.message));
  assert.deepEqual(merges(board, id), [], 'a refused forced merge records nothing');
  assert.throws(() => store.merged(board, id, { agentId: 'coordinator', commit: LANDED, forced: 'landed by hand', waiveProof: ' ' }),
    error => error.code === 'WAIVE_PROOF_REASON');
  store.merged(board, id, { agentId: 'coordinator', commit: LANDED, forced: 'landed by hand', waiveProof: 'gate was down' });
  assert.equal(merges(board, id)[0].waivedProof, 'gate was down');
});

test('clause 2: with a receipt the merged event carries the receipt ids, the landed commit and the item tip [C7,#4742]', t => {
  const { board, builder, id } = submittedItem(t);
  store.logEvent(board, builder, 'proof-run', id, { receipt: { id: 'stale-proof', kind: 'submit', item: id, commit: '1'.repeat(40), exitCode: 0 } });
  store.logEvent(board, builder, 'proof-run', id, { receipt: { id: 'red-proof', kind: 'submit', item: id, commit: TIP, exitCode: 1 } });
  assert.throws(() => store.merged(board, id, { agentId: 'coordinator', commit: LANDED, forced: 'landed by hand' }),
    error => error.code === 'FORCED_NO_PROOF', 'a receipt for another commit or a failing run does not cover the tip');
  store.logEvent(board, builder, 'proof-run', id, { receipt: { id: 'good-proof', kind: 'submit', item: id, commit: TIP, exitCode: 0 } });
  store.merged(board, id, { agentId: 'coordinator', commit: LANDED, forced: 'landed by hand' });
  const [event] = merges(board, id);
  assert.deepEqual([event.receipts, event.commit, event.itemTip, event.forced], [['good-proof'], LANDED, TIP, true]);
});
