/** A snapshot survives the connection's own bookkeeping write but not another connection's commit [B2,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { acknowledgeOwnWrites } from '../../../../index.js';
import { appendFact } from '../../../../index.js';
import { boardWriteSnapshot } from '../../../../index.js';
import { requireBoardWriteSnapshot } from '../../../../index.js';
import { cellBoard } from '../../../fixtures/cell.js';
import { cellItem } from '../../../fixtures/cell.js';
import { cellProject } from '../../../fixtures/cell.js';
import { cellSeat } from '../../../fixtures/cell.js';

/** A board with one item and the seat that may write to it. */
function setup(t) {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'web', path: project.repo });
  const item = cellItem(board, { lane: 'web', title: 'Own write fixture', specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  return { project, board, seat, item };
}

/** The write a lapsed-claim observation stands for: one of this connection's own rows. */
const ownWrite = (board, seat, item) => appendFact(board, item, { agentId: seat.id, kind: 'note', text: 'observation' });

test('clause 1: the connection\'s own acknowledged write leaves a prepared snapshot valid, an unacknowledged one voids it [B2,C7]', async t => {
  const { board, seat, item } = setup(t);
  const plain = boardWriteSnapshot(board);
  ownWrite(board, seat, item);
  assert.throws(() => requireBoardWriteSnapshot(board, plain, 'submit'), { code: 'BOARD_BUSY' }, 'an unacknowledged own write still voids the snapshot');
  const snapshot = boardWriteSnapshot(board);
  await acknowledgeOwnWrites(board, () => ownWrite(board, seat, item));
  assert.doesNotThrow(() => requireBoardWriteSnapshot(board, snapshot, 'submit'));
});

test('clause 2: another connection\'s commit during preparation still refuses BOARD_BUSY, even beside an acknowledged own write [B2,C7]', async t => {
  const { project, board, seat, item } = setup(t);
  const snapshot = boardWriteSnapshot(board);
  await acknowledgeOwnWrites(board, () => ownWrite(board, seat, item));
  const peer = new DatabaseSync(project.boardFile);
  t.after(() => peer.close());
  peer.prepare("INSERT OR REPLACE INTO board_meta(meta_key, meta_value) VALUES ('fixture:peer-write', '1')").run();
  assert.throws(() => requireBoardWriteSnapshot(board, snapshot, 'submit'), { code: 'BOARD_BUSY' });
});
