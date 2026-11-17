/** Two ordinary claims retain independent owners and frozen bars [B5,H16]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getItem } from '../../../store/index.js';
import { cellBoard } from '../fixtures/cell-board.js';
import { cellClaim } from '../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../store/tests/fixtures/cell.js';

test('one seat claims and renews two separate items [B5,H16]', t => {
  const project = cellProject(t, { real: true });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  const seat = cellSeat(board, { lane: 'web', path: project.repo });
  const add = title => cellItem(board, { lane: 'web', title, specIds: ['G1'], route: 'strong', criterion: 'the fixture works' }).item_id;
  const one = add('First fixture'), two = add('Second fixture');
  for (const item of [one, two, one, two]) cellClaim(board, item, seat, { root: project.repo, itemFolder: true });
  const a = getItem(board, one), b = getItem(board, two);
  assert.equal(a.item_status, 'claimed'); assert.equal(b.item_status, 'claimed');
  assert.equal(a.item_owner, b.item_owner); assert.ok(a.item_frozen_digest); assert.ok(b.item_frozen_digest);
});
