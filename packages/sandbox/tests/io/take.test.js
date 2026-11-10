/** next --take selects once on its read snapshot; the write runs only the chosen item's guards [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { takeSelection } from '../../src/io/take.js';
import { actorClaims } from '../fixtures/ports.js';
import { counted } from '../fixtures/ports.js';
import { fixture } from '../fixtures/ports.js';
import { take } from '../fixtures/ports.js';

test('next --take calls its selection and review offer once each [C7]', async t => {
  const box = fixture(t);
  const first = box.add('First open item');
  box.add('Second open item');
  const counts = counted(t, takeSelection);
  const taken = await take(box);
  assert.equal(taken.item?.item_id, first, JSON.stringify(taken));
  assert.deepEqual(counts, { selected: 1, reviewOffer: 1 }, 'the write transaction selected nothing');
});

test('a holding seat returns its claim from next --take without the mandatory review offer [C7]', async t => {
  const box = fixture(t);
  const held = box.add('Already held');
  box.add('Another open item');
  box.claim(held, box.seats.actor);
  const counts = counted(t, takeSelection);
  const taken = await take(box);
  assert.equal(taken.item?.item_id, held, JSON.stringify(taken));
  assert.deepEqual(counts, { selected: 1, reviewOffer: 0 });
  assert.deepEqual(actorClaims(box), [held]);
});

test('next --take: the write runs only the chosen item claim guards and selects again only when they refuse [C7]', async t => {
  const box = fixture(t);
  const raced = box.add('Raced by a peer');
  const spare = box.add('Still free', { brief: 'Files: web/spare.js\nTest: the real board claims the spare item.' });
  // A peer claims the chosen item after the read selection and before the write's claim guards run.
  const counts = counted(t, takeSelection, { selected: (value, call) => { if (call === 1) box.claim(value.item.item_id); } });
  const result = await take(box);
  assert.equal(store.getItem(box.board, raced).item_owner, box.seats.builder.id, 'the peer keeps the raced item');
  assert.equal(result.item?.item_id, spare, JSON.stringify(result));
  assert.deepEqual(actorClaims(box), [spare]);
  assert.equal(counts.selected, 2, 'one read selection per loop, none inside a write');
});
