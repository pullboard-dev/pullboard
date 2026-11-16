/** A settled hold lifts on the write that records main moving or the blocker leaving, behind holds.liftSettled [C7,#2962]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { describeSetting } from '../../../../packages/config/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';

/** A board with two open items, the first held on "waiting on #<second>"; liftSettled is switched on in the machine settings when asked. */
async function held(t, { lift }) {
  const box = await fixture(t);
  if (lift) {
    const file = machineSettingsFile();
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), holds: { liftSettled: true } }));
    box.board.liftSettledHolds = true;
  }
  const blocker = box.add('Blocker');
  const id = box.add('Held work');
  const placed = await cli(box, box.root, ['hold', String(id), `waiting on #${blocker}`]);
  assert.equal(placed.code, 0, placed.out + placed.err);
  return { box, id, blocker };
}

/** Record main moving, as the landing's batch does, on the fixture's own board connection. */
function moveMain(box) {
  store.atomic(box.board, () => store.logEvent(box.board, 'coordinator', 'main-moved', null, { sha: 'b'.repeat(40), batch: 'b1', items: [] }));
}

const reasonOf = f => store.getItem(f.box.board, f.id).item_hold_reason;

test('clause 1: holds.liftSettled is a described setting that defaults off, and with it off a settled hold stays after main moves [C7,#2962]', async t => {
  assert.equal(describeSetting('holds.liftSettled').unit, 'on/off');
  const f = await held(t, { lift: false });
  const withdrawn = await cli(f.box, f.box.root, ['withdraw', String(f.blocker), '--note', 'no longer needed']);
  assert.equal(withdrawn.code, 0, withdrawn.out + withdrawn.err);
  moveMain(f.box);
  assert.match(reasonOf(f), /waiting on #/u, 'the settled hold stays');
});

test('clause 2: with holds.liftSettled on, a hold whose reason names only a withdrawn item lifts on the next write after main moves [C7,#2962]', async t => {
  const f = await held(t, { lift: true });
  assert.match(reasonOf(f), /waiting on #/u, 'an open blocker keeps the hold');
  moveMain(f.box);
  assert.match(reasonOf(f), /waiting on #/u, 'main moving alone does not settle an open blocker');
  const withdrawn = await cli(f.box, f.box.root, ['withdraw', String(f.blocker), '--note', 'no longer needed']);
  assert.equal(withdrawn.code, 0, withdrawn.out + withdrawn.err);
  assert.equal(reasonOf(f), null, 'the withdrawn blocker settled the hold');
  assert.ok(f.box.board.db.prepare("SELECT 1 FROM event WHERE item_id=? AND event_kind='unhold_item' AND event_detail LIKE '%settled%'").get(f.id));
});

test('clause 3: with holds.liftSettled on, a parent hold lifts when every child has landed or been withdrawn [C7,#2962]', async t => {
  const f = await held(t, { lift: true });
  store.releaseItemHold(f.box.board, f.id, { agentId: 'coordinator', reason: 'lifted by hand' });
  const board = f.box.board;
  const child = f.box.add('Child', { parentId: f.id });
  store.holdItem(board, f.id, { agentId: 'coordinator', reason: 'parent waits for its children' });
  moveMain(f.box);
  assert.match(reasonOf(f), /children/u, 'an open child keeps the parent held');
  const withdrawn = await cli(f.box, f.box.root, ['withdraw', String(child), '--note', 'no longer needed']);
  assert.equal(withdrawn.code, 0, withdrawn.out + withdrawn.err);
  assert.equal(reasonOf(f), null, 'the done child settled the parent hold');
});
