/** next withdraws, as met, an open or claimed item whose own merge is on main, so no builder is offered it again [C7,#3961]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cli } from '../../tests/fixtures/next/take.js';
import { fixture } from '../../tests/fixtures/next/take.js';
import * as store from '../../../../packages/store/index.js';

/** Land an item the way the lander does: its own commit merged onto main with a `Merge #N onto main` subject; returns the merge commit. */
function landOnMain(box, id) {
  const branch = `landed-${id}`;
  box.git(box.root, 'checkout', '-q', '-b', branch);
  writeFileSync(join(box.root, `landed-${id}.txt`), `item ${id}\n`);
  box.git(box.root, 'add', '-A');
  box.git(box.root, 'commit', '-q', '-m', `feat: work of item ${id} [G1]`);
  box.git(box.root, 'checkout', '-q', 'main');
  box.git(box.root, 'merge', '-q', '--no-ff', '-m', `Merge #${id} onto main [G1]`, branch);
  return box.git(box.root, 'rev-parse', 'HEAD').trim();
}

/** The detail of an item's newest withdraw event. */
const withdrawn = (box, id) => JSON.parse(box.board.db.prepare("SELECT event_detail AS detail FROM event WHERE item_id = ? AND event_kind = 'withdraw' ORDER BY event_id DESC LIMIT 1").get(id).detail);

test('cli.journeys-next-met-at-main.landed-items-are-withdrawn-as-met: clause 1: next withdraws an open and a claimed item whose merge is on main, names the commit, and hands the seat the item that is not on main [C7,#3961]', async t => {
  const box = await fixture(t);
  const openLanded = box.add('Open item whose merge is on main');
  const claimedLanded = box.add('Claimed item whose merge is on main');
  const unlanded = box.add('Item whose work is not on main');
  box.claim(claimedLanded, box.seats.builder);
  const openCommit = landOnMain(box, openLanded);
  const claimedCommit = landOnMain(box, claimedLanded);
  box.git(box.seats.actor.path, 'merge', '-q', 'main');
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, unlanded, 'the item not on main is the one offered');
  for (const [id, commit] of [[openLanded, openCommit], [claimedLanded, claimedCommit]]) {
    assert.equal(store.getItem(box.board, id).item_status, 'withdrawn', `#${id} is withdrawn`);
    const detail = withdrawn(box, id);
    assert.equal(detail.commit, commit, `#${id} names the main commit that carries it`);
    assert.match(detail.reason, /^met on main/u);
  }
  assert.equal(store.getItem(box.board, unlanded).item_status, 'claimed');
});

test('cli.journeys-next-met-at-main.seat-refusal-is-kept: clause 1: a seat still cannot withdraw an item, even one whose merge is on main [C7,#3961]', async t => {
  const box = await fixture(t);
  const id = box.add('Item whose merge is on main, withdrawn by a seat');
  landOnMain(box, id);
  assert.throws(() => store.withdraw(box.board, id, { agentId: box.seats.actor.id, reason: 'met on main' }), { code: 'COORDINATOR_ONLY' });
  assert.equal(store.getItem(box.board, id).item_status, 'open');
});
