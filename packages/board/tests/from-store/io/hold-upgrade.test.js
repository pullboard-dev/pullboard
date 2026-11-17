/** A one-time upgrade gives each ownerless hold the coordinator and a deadline a day out, behind holds.requireOwner [C7,#8542]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { cellBoard } from '../../fixtures/cell-board.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';

const DAY = 86_400_000;
const LIGHT_BRIEF = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';

/** A real private board with a coordinator and two items, one of them held with no owner. */
function oldHolds(t) {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const add = title => cellItem(board, { lane: 'web', title, route: 'mid', criterion: 'The private fixture proves the hold.', brief: LIGHT_BRIEF, check: 'true' }).item_id;
  const held = add('Held before the upgrade');
  const free = add('Never held');
  store.holdItem(board, held, { agentId: 'coordinator', reason: 'an old hold', requireOwner: false });
  return { board, held, free };
}

test('board.hold-upgrade.the-upgrade-gives-each-existing-hold: clause 1: the upgrade gives each existing hold without an owner the coordinator and a deadline one day after the upgrade [C7,#8542]', t => {
  const { board, held, free } = oldHolds(t);
  assert.equal(store.itemHoldOwner(board, held), null);
  const upgraded = store.upgradeHoldOwners(board, { agentId: 'coordinator', requireOwner: true });
  assert.deepEqual(upgraded, [held]);
  const record = store.itemHoldOwner(board, held);
  assert.equal(record.owner, 'coordinator');
  assert.equal(Date.parse(record.deadline) - Date.parse(store.now(board)) <= DAY, true);
  assert.equal(Date.parse(record.deadline) - Date.parse(store.now(board)) > DAY - 60_000, true);
  assert.equal(store.itemHoldOwner(board, free), null, 'an item that was never held is untouched');
  store.releaseItemHold(board, held, { agentId: 'coordinator' });
  store.holdItem(board, held, { agentId: 'coordinator', reason: 'held again by a lane', requireOwner: true, owner: 'lane:web' });
  assert.deepEqual(store.upgradeHoldOwners(board, { agentId: 'coordinator', requireOwner: true }), [], 'the upgrade runs once');
  assert.equal(store.itemHoldOwner(board, held).owner, 'lane:web');
});

test('board.hold-upgrade.with-holds-requireowner-off-the-upgrade: clause 1: with holds.requireOwner off the upgrade changes nothing [C7,#8542]', t => {
  const { board, held } = oldHolds(t);
  assert.deepEqual(store.upgradeHoldOwners(board, { agentId: 'coordinator' }), []);
  assert.equal(store.itemHoldOwner(board, held), null);
});
