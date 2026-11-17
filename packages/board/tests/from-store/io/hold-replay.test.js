/** A hold replays the same on every machine whatever its holds.requireOwner setting: the decision rides in the move and the event [C7,#8569]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../store/index.js';
import { cellBoard } from '../../fixtures/cell-board.js';
import { cellProject } from '../../../../store/tests/fixtures/cell.js';
import { cellItem } from '../../../../store/tests/fixtures/cell.js';
import { cellSeat } from '../../../../store/tests/fixtures/cell.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

const LIGHT_BRIEF = 'Files:\n- web/page.js\nChange:\n- copy the header from the api\nTest:\n- the page test asserts the header\nOut of scope: anything else\n';

/** Point this process at a machine home whose holds.requireOwner is as given; restored when the test ends. */
function onMachine(t, dir, requireOwner) {
  const home = join(dir, `machine-home-${requireOwner}`);
  mkdirSync(home, { recursive: true });
  fixtureMachineSettings(home, { holds: { requireOwner } });
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  t.after(() => { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; });
}

/** A real private board with a coordinator and two open items. */
function machine(t) {
  const project = cellProject(t, { real: true, gate: 'true' });
  const board = cellBoard(t, project.boardFile, undefined, { real: true, gitRoot: project.repo });
  cellSeat(board, { lane: 'coordinator', path: project.repo });
  const add = title => cellItem(board, { lane: 'web', title, route: 'mid', criterion: 'The private fixture proves the hold.', brief: LIGHT_BRIEF, check: 'true' }).item_id;
  return { board, dir: project.dir, ids: [add('First'), add('Second')] };
}

/** What a replica's board shows for a held item: the hold row, its owner record and the event detail. */
function shown(board, id) {
  return { hold: store.itemHold(board, id), owner: store.itemHoldOwner(board, id),
    detail: JSON.parse(store.events(board, { itemId: id }).at(-1).event_detail) };
}

test('clause 1: a hold written with holds.requireOwner on replays to the same board state on a machine with it off [C7,#8569]', t => {
  const writer = machine(t);
  const replica = machine(t);
  const move = { agentId: 'coordinator', requireOwner: true, reason: 'wait for the design', owner: 'lane:web', deadline: '2030-01-02T03:04:05Z' };
  onMachine(t, writer.dir, true);
  store.holdItem(writer.board, writer.ids[0], move);
  onMachine(t, writer.dir, false);
  store.holdItem(replica.board, replica.ids[0], move);
  const a = shown(writer.board, writer.ids[0]);
  const b = shown(replica.board, replica.ids[0]);
  assert.equal(a.owner.owner, 'lane:web');
  assert.deepEqual(b.owner, a.owner);
  assert.deepEqual(b.detail, a.detail);
  assert.equal(b.hold.item_hold_reason, a.hold.item_hold_reason);
  // A hold whose move carries no decision replays as off, never as whatever this machine's setting says.
  onMachine(t, writer.dir, true);
  store.holdItem(writer.board, writer.ids[1], { agentId: 'coordinator', reason: 'automatic park' });
  assert.equal(store.itemHoldOwner(writer.board, writer.ids[1]), null);
});

test('clause 2: every hold write path records the requireOwner decision in its event [C7,#8569]', t => {
  const { board, dir, ids } = machine(t);
  onMachine(t, dir, true);
  store.holdItem(board, ids[0], { agentId: 'coordinator', requireOwner: true, reason: 'owned hold', owner: 'a seat' });
  assert.equal(shown(board, ids[0]).detail.requireOwner, true, 'a hold made under the rule records that it was');
  assert.throws(() => store.holdItem(board, ids[1], { agentId: 'coordinator', requireOwner: true, reason: 'no owner' }), error => error.code === 'HOLD_OWNER_REQUIRED');
  store.holdItem(board, ids[1], { agentId: 'coordinator', reason: 'automatic park' });
  assert.equal(Object.hasOwn(shown(board, ids[1]).detail, 'requireOwner'), false, 'a hold made without the rule records no decision, which reads as off');
});
