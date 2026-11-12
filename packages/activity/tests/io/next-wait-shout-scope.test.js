/** A shout ends next --wait only for an item this seat can act on; any other shout prints and the wait goes on [C7,#4057]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cellBoard } from '../../../store/tests/fixtures/cell.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellRepo } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';
import { shout } from '../../../store/index.js';
import { takeWaitShouts } from '../../index.js';

/** A board with the asked seat (web lane), a sender, and a seat in another lane; shouts go through the real inbox. */
function fixture(t) {
  const repo = cellRepo(t);
  const board = cellBoard(t, repo.boardFile);
  const asked = cellSeat(board, { lane: 'web', path: `${repo.root}/a` });
  const sender = cellSeat(board, { lane: 'api', path: `${repo.root}/b` });
  const rival = cellSeat(board, { lane: 'web', path: `${repo.root}/c` });
  const ports = { withBoard: (_ctx, work) => work(board), withBoardRead: (_ctx, work) => work(board), whoAmI: () => ({ id: asked.id }) };
  const hear = text => {
    shout(board, { from: sender.id, to: asked.id, text, lanes: ['web', 'api'] });
    return takeWaitShouts({}, new Set(), ports);
  };
  return { repo, board, asked, rival, hear };
}

test('clause 1: a shout naming an open item in this seat\'s lane ends the wait [C7,#4057]', t => {
  const { board, hear } = fixture(t);
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  const heard = hear(`please build #${item.item_id} next`);
  assert.equal(heard.item?.item_id, item.item_id);
});

test('clause 1: a shout naming an open item in another lane is printed and the wait continues [C7,#4057]', t => {
  const { board, hear } = fixture(t);
  const item = cellItem(board, { lane: 'api', title: 'Build the endpoint' });
  const heard = hear(`please build #${item.item_id} next`);
  assert.equal(heard.item, null);
  assert.equal(heard.lines.length, 1);
  assert.match(heard.lines[0], new RegExp(`please build #${item.item_id} next`, 'u'));
});

test('clause 1: a shout naming an item another seat holds is printed and the wait continues [C7,#4057]', t => {
  const { repo, board, rival, hear } = fixture(t);
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, rival, { root: repo.root });
  const heard = hear(`please build #${item.item_id} next`);
  assert.equal(heard.item, null);
  assert.equal(heard.lines.length, 1);
});

test('clause 1: a shout naming an item this seat holds ends the wait [C7,#4057]', t => {
  const { repo, board, asked, hear } = fixture(t);
  const item = cellItem(board, { lane: 'web', title: 'Build the page' });
  cellClaim(board, item.item_id, asked, { root: repo.root });
  assert.equal(hear(`please fix #${item.item_id} soon`).item?.item_id, item.item_id);
});
