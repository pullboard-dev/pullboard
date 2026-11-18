/** next --take selects once on its read snapshot; the write runs only the chosen item's guards [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { mainRedBuildOffer } from '../../src/io/take.js';
import { takeSelection } from '../../src/io/take.js';
import { nextProgress } from '../../src/io/take.js';
import { actorClaims } from '../fixtures/ports.js';
import { counted } from '../fixtures/ports.js';
import { fixture } from '../fixtures/ports.js';
import { take } from '../fixtures/ports.js';

test('sandbox.take.selection-and-offer-once: next --take calls its selection and review offer once each [C7]', async t => {
  const box = fixture(t);
  const first = box.add('First open item');
  box.add('Second open item');
  const counts = counted(t, takeSelection);
  const taken = await take(box);
  assert.equal(taken.item?.item_id, first, JSON.stringify(taken));
  assert.deepEqual(counts, { selected: 1, reviewOffer: 1 }, 'the write transaction selected nothing');
});

test('sandbox.take.holding-seat-returns-claim: a holding seat returns its claim from next --take without the mandatory review offer [C7]', async t => {
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

test('sandbox.take.write-runs-chosen-item-guards: next --take: the write runs only the chosen item claim guards and selects again only when they refuse [C7]', async t => {
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

/** A next's progress on a hand-moved clock, so a phase can outlast the whole budget without waiting for it. */
function slowProgress(t) {
  const clock = { at: 0 };
  const progress = nextProgress({ stderr: { write() {} } }, { timeoutMs: 1_000, phaseMs: 500, now: () => clock.at });
  t.after(progress.stop);
  return { clock, progress };
}

test('sandbox.take.claim-kept-past-budget: clause 1: a claim written as the routing budget runs out is returned, and the code map run after it completes [N2,C7]', async t => {
  const { clock, progress } = slowProgress(t);
  const found = await progress.run('selection', null, async () => {
    progress.enter('claim', 7);
    // The claim's write outlasts the whole budget: the board now holds it for this seat.
    clock.at = 2_000;
    return { item: { item_id: 7 }, itemFolder: '/seat-item-7' };
  });
  assert.equal(found.item.item_id, 7, 'the committed claim is the answer, not NEXT_TIMEOUT');
  let mapped = false;
  await progress.run('code map', 7, () => { mapped = true; });
  assert.equal(mapped, true, 'the phases after the claim still run');
});

test('sandbox.take.no-claim-still-times-out: clause 2: a run past the budget that returns no item, a retry, or an item it never claimed still refuses NEXT_TIMEOUT [N2,C7]', async t => {
  const runs = [
    ['selection', true, { reasons: [] }],
    ['selection', true, { retry: true, item: { item_id: 7 }, retryDetail: { phase: 'claim', item: 7, code: 'HELD' } }],
    ['main-red routing', false, { item: { item_id: 7 }, reasons: [] }],
  ];
  for (const [name, claims, result] of runs) {
    const { clock, progress } = slowProgress(t);
    await assert.rejects(progress.run(name, null, async () => {
      if (claims) progress.enter('claim', 7);
      clock.at = 2_000;
      return result;
    }), error => error.code === 'NEXT_TIMEOUT', JSON.stringify([name, result]));
  }
});

test('sandbox.take.main-red-claim-worktrees-in-flight: clause 1: the claim worktrees main-red routing is handed list only in-flight items and return the claimed items\' recorded files as the whole open list does [C7,#5329]', t => {
  const box = fixture(t);
  const repair = box.add('Main red repair');
  const held = box.add('Held by the builder');
  box.add('Another open item');
  box.claim(held);
  const seen = [];
  /** What recordedClaimWorktrees answers: each claimed item's files, and nothing for any other item. */
  const recorded = items => new Map(items.filter(item => item.item_status === 'claimed').map(item => [item.item_id, { files: [`web/${item.item_id}.js`], unknown: false }]));
  const claimWorktrees = items => {
    seen.push(items);
    return recorded(items);
  };
  const offer = mainRedBuildOffer(box.ctx, {}, { ...box.services, mainRedReworkItems: () => [repair], claimWorktrees });
  assert.equal(seen.length, 1, `the routing read the claim worktrees once; offer ${JSON.stringify(offer)}`);
  assert.ok(seen[0].some(item => item.item_id === held), 'the claimed item is listed');
  assert.deepEqual([...new Set(seen[0].map(item => item.item_status))].sort(), ['claimed'], 'no open item is listed for the claim worktrees');
  assert.deepEqual(recorded(seen[0]), recorded(store.listItems(box.board)), 'the same claimed items\' recorded files as the whole open list gives');
});
