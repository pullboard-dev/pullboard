/** A hold names its owner and a deadline behind holds.requireOwner, and is unchanged with it off [C7,#8539]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../index.js';
import { cellBoard } from '../fixtures/cell.js';
import { cellProject } from '../fixtures/cell.js';
import { cellItem } from '../fixtures/cell.js';
import { cellSeat } from '../fixtures/cell.js';

const DAY = 86_400_000;
const LIGHT_BRIEF = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';

/** A real private board with a coordinator and one open item, on an empty machine home, so the setting is at its default. */
function heldBoard(t) {
  const project = cellProject(t, { real: true, gate: 'true' });
  const home = join(project.dir, 'machine-home');
  mkdirSync(home);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const id = cellItem(board, { lane: 'web', title: 'Held work', route: 'mid',
    criterion: 'The private fixture proves the hold.', brief: LIGHT_BRIEF, check: 'true' }).item_id;
  return { board, id };
}

test('clause 1: holdItem stores an owner and a deadline one day out when holds.requireOwner is on [C7,#8539]', t => {
  const { board, id } = heldBoard(t);
  const held = store.holdItem(board, id, { agentId: 'coordinator', requireOwner: true, reason: 'wait for the design', owner: 'lane:web' });
  const record = store.itemHoldOwner(board, id);
  assert.equal(record.owner, 'lane:web');
  assert.equal(Date.parse(record.deadline) - Date.parse(held.item_hold_at), DAY);
  assert.throws(() => store.holdItem(board, id, { agentId: 'coordinator', reason: 'no owner named', requireOwner: true }), error => error.code === 'HOLD_OWNER_REQUIRED');
  store.releaseItemHold(board, id, { agentId: 'coordinator' });
  assert.equal(store.itemHoldOwner(board, id), null, 'lifting the hold forgets its owner');
  store.holdItem(board, id, { agentId: 'coordinator', requireOwner: true, reason: 'a named deadline', owner: 'a seat', deadline: '2030-01-02T03:04:05Z' });
  assert.equal(store.itemHoldOwner(board, id).deadline, '2030-01-02T03:04:05.000Z');
});

test('clause 2: holds.requireOwner is off by default and a hold is exactly as before [C7,#8539]', t => {
  const { board, id } = heldBoard(t);
  const hold = store.holdItem(board, id, { agentId: 'coordinator', reason: 'plain hold' });
  assert.deepEqual(Object.keys(hold).sort(), ['item_hold_at', 'item_hold_by', 'item_hold_reason', 'item_id']);
  assert.equal(store.itemHoldOwner(board, id), null);
  const detail = JSON.parse(store.events(board, { itemId: id }).at(-1).event_detail);
  assert.equal(detail.reason, 'plain hold');
  assert.equal(Object.hasOwn(detail, 'owner') || Object.hasOwn(detail, 'deadline'), false);
});
