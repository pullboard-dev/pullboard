/** next selects once on its read snapshot; the write runs only the chosen item's guards [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { cli, fixture } from './next-take-fixture.js';
import { nextSelection } from '../apps/cli/src/shell/cli/next.js';
import { takeSelection } from '../packages/sandbox/src/shell/next-take.js';

/** Count calls to each entry of a selection seam, optionally running a hook after each, and restore it after the test. */
function counted(t, seam, after = {}) {
  const counts = Object.fromEntries(Object.keys(seam).map(name => [name, 0]));
  const original = { ...seam };
  for (const name of Object.keys(seam)) {
    seam[name] = (...args) => {
      counts[name]++;
      const value = original[name](...args);
      after[name]?.(value, counts[name]);
      return value;
    };
  }
  t.after(() => Object.assign(seam, original));
  return counts;
}

/** The items the actor seat holds as build claims. */
const actorClaims = box => store.listItems(box.board)
  .filter(item => item.item_status === 'claimed' && item.item_owner === box.seats.actor.id).map(item => item.item_id);

test('next --take and next call their selection and review offer once each [C7]', async t => {
  const box = await fixture(t);
  const first = box.add('First open item');
  const second = box.add('Second open item');
  const take = counted(t, takeSelection);
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, first);
  assert.deepEqual(take, { selected: 1, reviewOffer: 1 }, 'the write transaction selected nothing');
  store.release(box.board, first, box.seats.actor.id, 'Return the fixture claim for the plain next run', 'OTHER');
  box.advance(31 * 60_000);
  const plain = counted(t, nextSelection);
  const next = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(next.code, 0, next.out + next.err);
  assert.ok([first, second].includes(next.document.item.item_id), next.out);
  assert.deepEqual(plain, { pick: 1, reviewOffer: 1 }, 'nextPick ran once, outside the write');
});

test('a holding seat returns its claim without the mandatory review offer or another selection [C7]', async t => {
  const box = await fixture(t);
  const held = box.add('Already held');
  box.add('Another open item');
  box.claim(held, box.seats.actor);
  const take = counted(t, takeSelection);
  const taken = await cli(box, box.seats.actor.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, held);
  assert.deepEqual(take, { selected: 1, reviewOffer: 0 });
  const plain = counted(t, nextSelection);
  const next = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(next.code, 0, next.out + next.err);
  assert.equal(next.document.item.item_id, held);
  assert.deepEqual(plain, { pick: 1, reviewOffer: 1 });
  assert.deepEqual(actorClaims(box), [held]);
});

for (const [args, seam, name] of [[['next', '--take'], takeSelection, 'selected'], [['next'], nextSelection, 'pick']]) {
  test(`${args.join(' ')}: the write runs only the chosen item claim guards and selects again only when they refuse [C7]`, async t => {
    const box = await fixture(t);
    const raced = box.add('Raced by a peer');
    const spare = box.add('Still free', { brief: 'Files: web/spare.js\nTest: the real board claims the spare item.' });
    // A peer claims the chosen item after the read selection and before the write's claim guards run.
    const counts = counted(t, seam, { [name]: (value, call) => { if (call === 1) box.claim(value.item.item_id); } });
    const result = await cli(box, box.seats.actor.path, args);
    assert.equal(result.code, 0, result.out + result.err);
    assert.equal(store.getItem(box.board, raced).item_owner, box.seats.builder.id, 'the peer keeps the raced item');
    assert.equal(result.document.item.item_id, spare);
    assert.deepEqual(actorClaims(box), [spare]);
    assert.equal(counts[name], 2, 'one read selection per loop, none inside a write');
  });
}
