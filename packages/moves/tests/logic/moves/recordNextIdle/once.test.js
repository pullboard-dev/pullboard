/** next selects once on its read snapshot; the write runs only the chosen item's guards [C7]. The --take cases live in the sandbox cell. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../store/index.js';
import { cellClaim } from '../../../../../store/tests/fixtures/cell.js';
import { actorClaims } from '../../../fixtures/next.js';
import { counted } from '../../../fixtures/next.js';
import { fixture } from '../../../fixtures/next.js';
import { next } from '../../../fixtures/next.js';
import { nextSelection } from '../../../../index.js';

test('moves.record-next-idle-once.next-calls-its-selection-and-default-loop-review: next calls its selection and default-loop review offer once each [C7]', async t => {
  const box = fixture(t);
  const first = box.add('First open item');
  const second = box.add('Second open item');
  // The seat took and returned a claim before, as the command fixture's next --take did.
  cellClaim(box.board, first, box.seats.actor, { root: box.project.repo });
  store.release(box.board, first, box.seats.actor.id, 'Return the fixture claim for the plain next run', 'OTHER');
  box.advance(31 * 60_000);
  const plain = counted(t, nextSelection);
  const found = await next(box);
  assert.ok([first, second].includes(found.item?.item_id), JSON.stringify(found));
  // Plain next is the default loop: its one review offer is the default-loop review, never the build-intent offer (deb8696e48).
  assert.deepEqual(plain, { pick: 1, reviewOffer: 0, defaultOffer: 1 }, 'nextPick ran once, outside the write');
});

test('moves.record-next-idle-once.a-holding-seat-returns-its-claim-from: a holding seat returns its claim from next without another selection [C7]', async t => {
  const box = fixture(t);
  const held = box.add('Already held');
  box.add('Another open item');
  box.claim(held, box.seats.actor);
  const plain = counted(t, nextSelection);
  const found = await next(box);
  assert.equal(found.item?.item_id, held, JSON.stringify(found));
  assert.deepEqual(plain, { pick: 1, reviewOffer: 0, defaultOffer: 1 });
  assert.deepEqual(actorClaims(box), [held]);
});

test('moves.record-next-idle-once.next-the-write-runs-only-the-chosen: next: the write runs only the chosen item claim guards and selects again only when they refuse [C7]', async t => {
  const box = fixture(t);
  const raced = box.add('Raced by a peer');
  const spare = box.add('Still free', { brief: 'Files: web/spare.js\nTest: the real board claims the spare item.' });
  // A peer claims the chosen item after the read selection and before the write's claim guards run.
  const counts = counted(t, nextSelection, { pick: (value, call) => { if (call === 1) box.claim(value.item.item_id); } });
  const result = await next(box);
  assert.equal(store.getItem(box.board, raced).item_owner, box.seats.builder.id, 'the peer keeps the raced item');
  assert.equal(result.item?.item_id, spare, JSON.stringify(result));
  assert.deepEqual(actorClaims(box), [spare]);
  assert.equal(counts.pick, 2, 'one read selection per loop, none inside a write');
});
