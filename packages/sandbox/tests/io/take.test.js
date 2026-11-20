/** next --take selects once on its read snapshot; the write runs only the chosen item's guards [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../store/index.js';
import { DatabaseSync } from 'node:sqlite';
import { closePassingMainReds } from '../../src/io/take.js';
import { mainRedBuildOffer } from '../../src/io/take.js';
import { takeSelection } from '../../src/io/take.js';
import { nextProgress } from '../../src/io/take.js';
import { cellBoard } from '../../../board/tests/fixtures/cell-board.js';
import { Refused } from '../../../kernel/index.js';
import { nextTake } from '../../src/io/take.js';
import { reportUnbuildableOnce } from '../../src/io/take.js';
import { actorClaims } from '../fixtures/ports.js';
import { counted } from '../fixtures/ports.js';
import { fixture } from '../fixtures/ports.js';
import { take } from '../fixtures/ports.js';

test('sandbox.take.selection-and-offer-once: next --take calls its selection and review offer once each [C7]', async t => {
  const box = fixture(t, cellBoard);
  const first = box.add('First open item');
  box.add('Second open item');
  const counts = counted(t, takeSelection);
  const taken = await take(box);
  assert.equal(taken.item?.item_id, first, JSON.stringify(taken));
  assert.deepEqual(counts, { selected: 1, reviewOffer: 1 }, 'the write transaction selected nothing');
});

test('sandbox.take.holding-seat-returns-claim: a holding seat returns its claim from next --take without the mandatory review offer [C7]', async t => {
  const box = fixture(t, cellBoard);
  const held = box.add('Already held');
  box.add('Another open item');
  box.claim(held, box.seats.actor);
  const counts = counted(t, takeSelection);
  const taken = await take(box);
  assert.equal(taken.item?.item_id, held, JSON.stringify(taken));
  assert.deepEqual(counts, { selected: 1, reviewOffer: 0 });
  assert.deepEqual(actorClaims(box), [held]);
});

test('sandbox.take.one-claim-per-call: clause 1: next --take on a board with five claimable items in two lanes leaves the seat holding exactly one claim, and a repeat call, as the retry after NEXT_TIMEOUT is, returns that same claim [C7]', async t => {
  const box = fixture(t, cellBoard);
  for (const title of ['One', 'Two', 'Three']) box.add(title);
  for (const title of ['Four', 'Five']) box.add(title, { lane: 'docs' });
  const first = await take(box);
  assert.ok(first.item, JSON.stringify(first));
  assert.equal(actorClaims(box).length, 1, 'one call claims one item');
  const again = await take(box);
  assert.equal(again.item.item_id, first.item.item_id, 'the repeat call returns the held claim');
  assert.equal(again.held, true);
  assert.deepEqual(actorClaims(box), [first.item.item_id], 'no second claim while the first is unsubmitted with a live lease');
});

test('sandbox.take.write-runs-chosen-item-guards: next --take: the write runs only the chosen item claim guards and selects again only when they refuse [C7]', async t => {
  const box = fixture(t, cellBoard);
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
  const box = fixture(t, cellBoard);
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

/** The SQL a work function prepares on any connection, recorded by wrapping DatabaseSync.prototype.prepare. */
async function preparedBy(t, work) {
  const prepared = [];
  const prepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function recording(sql) { prepared.push(String(sql)); return prepare.call(this, sql); };
  t.after(() => { DatabaseSync.prototype.prepare = prepare; });
  try { await work(); } finally { DatabaseSync.prototype.prepare = prepare; }
  return prepared;
}

test('sandbox.take.closing-reads-no-list-without-main-run: clause 1: closePassingMainReds with no run recorded for main\'s commit sends the board no open-items list query [C7,#5329]', async t => {
  const box = fixture(t, cellBoard);
  box.add('Open item one');
  box.add('Open item two');
  const listing = await preparedBy(t, () => store.listItems(box.board));
  assert.ok(listing.length > 0, 'the open-items list read prepares a query');
  /** passingMainRedItems with no run recorded for main: it answers nothing and never calls a function it is given. */
  const passingMainRedItems = () => [];
  const closing = await preparedBy(t, () => closePassingMainReds(box.ctx, { ...box.services, passingMainRedItems }));
  assert.deepEqual(closing.filter(sql => listing.includes(sql)), [], `the closing read prepared a list query: ${JSON.stringify(closing)}`);
});

test('sandbox.take.claim-substeps-profile: after progress.enter claim, entering claim freezer, claim head and claim write lists each as its own profile row, the rows sum to the claim phase, and a claim step past the routing budget does not throw NEXT_TIMEOUT [N2,C7]', async t => {
  const { clock, progress } = slowProgress(t);
  progress.enter('claim', 7);
  clock.at += 10;
  progress.enter('claim freezer', 7);
  clock.at += 30;
  progress.enter('claim head', 7);
  clock.at += 5;
  progress.enter('claim write', 7);
  clock.at += 2_000; // the routing budget (1,000 ms) runs out inside the write
  assert.doesNotThrow(() => progress.enter('claim cover-stuck', 7), 'a claim step past the budget keeps custody and never refuses');
  clock.at += 8;
  const rows = new Map(progress.profile().map(row => [row.phase, row.ms]));
  assert.equal(rows.get('claim'), 10);
  assert.equal(rows.get('claim freezer'), 30);
  assert.equal(rows.get('claim head'), 5);
  assert.equal(rows.get('claim write'), 2_000);
  assert.equal(rows.get('claim cover-stuck'), 8);
  assert.equal([...rows].filter(([name]) => name.startsWith('claim')).reduce((sum, [, ms]) => sum + ms, 0), 2_053, 'the claim rows sum to the time the claim phase took');
});

test('sandbox.io-take.unbuildable-held-rebar: clause 1: next --take passing over a BAR_PATH_MISSING bar holds the item with a reason starting "re-bar:" that names the code, a second pass-over adds no second hold, and a hold already on an item stays [C7,#12469]', async t => {
  const box = fixture(t, cellBoard);
  const broken = box.add('Bar names a missing file');
  box.services.claimOrdered = () => { throw new Refused('BAR_PATH_MISSING', '[BAR_PATH_MISSING] the bar names test/eligibility.test.js, missing from main'); };
  const skipped = await nextTake(box.ctx, { take: true, observeIdle: true }, box.services);
  assert.equal(skipped.skipItem, broken, JSON.stringify(skipped));
  const hold = store.itemHold(box.board, broken);
  assert.ok(hold?.item_hold_reason.startsWith('re-bar: BAR_PATH_MISSING: '), JSON.stringify(hold));
  assert.ok(hold.item_hold_reason.includes('test/eligibility.test.js'), 'the hold keeps the refusal message');
  box.advance(60_000);
  const again = await nextTake(box.ctx, { take: true, observeIdle: true }, box.services);
  assert.notEqual(again.item?.item_id, broken, 'a held item is not offered again');
  const refusal = { code: 'BAR_PATH_MISSING', message: '[BAR_PATH_MISSING] the bar names test/eligibility.test.js, missing from main' };
  await reportUnbuildableOnce(box.ctx, box.board, store.getItem(box.board, broken), box.seats.actor, refusal, box.services.ordered);
  assert.deepEqual(store.itemHold(box.board, broken), hold, 'a second report of the same bar holds nothing new');
  const other = box.add('Held by the coordinator first');
  store.holdItem(box.board, other, { agentId: 'coordinator', reason: 'kept for the person' });
  const kept = store.itemHold(box.board, other);
  await reportUnbuildableOnce(box.ctx, box.board, store.getItem(box.board, other), box.seats.actor, refusal, box.services.ordered);
  assert.deepEqual(store.itemHold(box.board, other), kept, 'a hold already on the item is not touched');
});
