/** next prints "you hold" only after re-reading a live claim by this seat; a lapsed lease falls through to selection [C7,#4056]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  fixture,
  cli,
} from '../../tests/fixtures/next/take.js';
import * as store from '../../../../packages/store/index.js';

/** The shared fixture with its board bound to the repository, as a modern submit requires. */
async function board(t) {
  const box = await fixture(t);
  box.board.gitRoot = box.root;
  return box;
}

test('clause 1: next with a live claim answers you hold it, and with a lapsed lease selects other work instead [C7,#4056]', async t => {
  const box = await board(t);
  const seat = box.seats.actor;
  const mine = box.add('Claimed build', { brief: 'Files: web/mine.js\nTest: the claim stays fresh.' });
  const other = box.add('Other build', { brief: 'Files: web/other.js\nTest: other work.' });
  const claim = await cli(box, seat.path, ['claim', String(mine), '--no-next']);
  assert.equal(claim.code, 0, claim.out + claim.err);

  const live = await cli(box, seat.path, ['next']);
  assert.equal(live.code, 0, live.out + live.err);
  assert.equal(live.document.item.item_id, mine);
  assert.equal(live.document.held, true, 'a live lease is still held');

  box.advance(30 * 24 * 3_600_000);
  assert.ok(!(store.getItem(box.board, mine).item_lease_until > box.clock.now().toISOString()), 'the lease lapsed');
  const lapsed = await cli(box, seat.path, ['next']);
  assert.equal(lapsed.code, 0, lapsed.out + lapsed.err);
  assert.notEqual(lapsed.document.held, true, `a lapsed lease is never printed as held: ${lapsed.out}`);
  assert.notEqual(lapsed.document.item?.item_id, mine);
  void other;
});
