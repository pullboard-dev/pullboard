import { QUEUE_PREEMPT_ENGINE } from '../../../../../packages/state/light.js';
/** Native board routing assertions; no gate or current-main result is fabricated [C7,N2]. */
import assert from 'node:assert/strict';
import { compareMainFailures } from '../../../../../packages/landing/index.js';
import { mainRedReworkItems } from '../../../../../packages/landing/index.js';
import * as store from '../../../../../packages/store/index.js';
import { exportBoard } from '../../../../../packages/store/index.js';
import { heartbeatSeat } from '../../../../../packages/store/index.js';
import { mainRedBuildRouting } from '../../../../../packages/store/index.js';
import { fixtureBoard } from '../board.js';

/** Build real registered seats with an injected clock and ordinary claims, without executing a gate. */
function routingFixture(t) {
  let at = Date.parse('2026-10-27T12:00:00Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  const seats = Object.fromEntries(['older', 'newer', 'free'].map(name => [name,
    store.register(board, { lane: 'web', path: `/private/routing-${name}`, route: 'strong' })]));
  const add = (title, file) => store.addItem(board, { by: 'coordinator', lane: 'web', title,
    criterion: 'Native dispatch remains eligible.', check: 'true', brief: `Files: web/${file}.js` });
  const claim = (id, owner) => store.claim(board, id, { agentId: owner, lane: 'web', leaseMs: 7_200_000,
    freeze: item => ({ text: item.item_title, digest: `fixture:${item.item_title}` }) });
  return { board, seats, add, claim, advance: ms => { at += ms; } };
}

/** A free idle same-lane seat wins, without changing any existing ownership, lease, or event. */
export function assertFreeMainRedRouting(t) {
  const f = routingFixture(t);
  const old = f.add('Older half-built work', 'older');
  f.claim(old, f.seats.older);
  f.advance(60_000);
  const newer = f.add('Newer work', 'newer');
  f.claim(newer, f.seats.newer);
  f.advance(600_000);
  assert.equal(store.agentById(f.board, f.seats.free).presence, 'idle');
  const repair = f.add('Actual evidenced repair supplied by caller', 'repair');
  const before = exportBoard(f.board);
  const plan = mainRedBuildRouting(f.board, { priority: [repair], caller: f.seats.older });
  assert.deepEqual(plan.buildOffer, { seat: f.seats.free, item: repair, path: '/private/routing-free' });
  assert.equal(plan.releaseRequest, undefined);
  assert.deepEqual(exportBoard(f.board), before, 'an offer never releases, claims, renews or appends an event');
  assert.equal(mainRedBuildRouting(f.board, { priority: [], caller: f.seats.older }), null, 'no main-red evidence means no routing');
  assert.equal(mainRedBuildRouting(f.board, { priority: [repair], routes: [], caller: f.seats.older }), null,
    'explicit route filters apply to the main-red path too');
}

/** With no free seat, native claim order wins over renewals; peer collisions remain authoritative. */
export function assertNewestMainRedRouting(t) {
  const f = routingFixture(t);
  f.board.executionEngineVersion = QUEUE_PREEMPT_ENGINE - 1; // Preserve the historical newest-claim request contract.
  const old = f.add('Older half-built work', 'old');
  f.claim(old, f.seats.older);
  f.advance(60_000);
  const newer = f.add('Newest work', 'repair');
  f.claim(newer, f.seats.newer);
  const other = f.add('Third occupied seat', 'other');
  f.claim(other, f.seats.free);
  f.advance(60_000);
  f.claim(old, f.seats.older);
  // The third seat is genuinely gone; it is not a free or idle alternative.
  f.advance(1_800_000);
  heartbeatSeat(f.board, f.seats.older);
  heartbeatSeat(f.board, f.seats.newer);
  const repair = f.add('Repair shares only the simulated released build', 'repair');
  const before = exportBoard(f.board);
  const plan = mainRedBuildRouting(f.board, { priority: [repair], caller: f.seats.older });
  assert.deepEqual(plan.releaseRequest, { seat: f.seats.newer, item: newer, repair, path: '/private/routing-newer' });
  assert.equal(plan.buildOffer, undefined);
  assert.deepEqual(exportBoard(f.board), before);
  assert.equal(store.nextFor(f.board, { agentId: f.seats.newer, lane: 'web', afterRelease: old }).item.item_id,
    newer, 'another seat claim cannot suppress the actual held claim');
  assert.throws(() => f.claim(repair, f.seats.newer), error => error.code === 'ONE_CLAIM', 'planning never grants claim authority');
  store.editItem(f.board, other, { agentId: 'coordinator', brief: 'Files: web/repair.js' });
  // Since 9abe146a9e [C7] open work that only overlaps another claim is claimable (claim warns, never refuses),
  // so a different occupied claim no longer blocks the shared repair: the newest build is still asked to release.
  assert.deepEqual(mainRedBuildRouting(f.board, { priority: [repair], caller: f.seats.older })?.releaseRequest,
    { seat: f.seats.newer, item: newer, repair, path: '/private/routing-newer' },
    'a different occupied claim only overlaps the shared repair; it does not block the release request');
}

/** Exercise default next and next --take against an actually measured red private main. */
export async function assertMainRedCLI(t, { fixture, cli }) {
  const box = await fixture(t, { mainRed: true, perSeat: 1 }); // 9cce05c94b: next tops a seat up to N claims; keep the board unchanged
  const old = box.add('Older half-built item', { specIds: ['G2'], brief: 'Files: web/older.js' });
  box.claim(old, box.seats.actor);
  const repair = box.add('Repair actual main failure', { brief: 'Files: web/repair.js' });
  const review = box.add('Unrelated held review', { specIds: ['G2'], brief: 'Files: docs/held-review.js' });
  box.submit(review);
  store.reserveReview(box.board, review, { agentId: box.seats.outside.id, leaseMs: 3_600_000, policy: 'any' });
  const context = process.env.NODE_TEST_CONTEXT;
  let comparison;
  try {
    delete process.env.NODE_TEST_CONTEXT;
    comparison = await compareMainFailures(box.root, { tests: [{ file: 'test/main-red.test.js', passed: false }] });
  } finally {
    if (context === undefined) delete process.env.NODE_TEST_CONTEXT;
    else process.env.NODE_TEST_CONTEXT = context;
  }
  assert.equal(comparison.unavailable, undefined, JSON.stringify(comparison));
  assert.deepEqual(comparison.files, [{ file: 'test/main-red.test.js', result: 'red' }]);
  assert.deepEqual(mainRedReworkItems(box.root, box.board), [repair]);
  const reviewing = exportBoard(box.board);
  assert.equal(mainRedBuildRouting(box.board, { priority: [repair], caller: box.seats.outside.id }), null);
  assert.deepEqual(exportBoard(box.board), reviewing, 'the router does not disturb a caller-held review');
  assert.equal(mainRedBuildRouting(box.board, { priority: [repair], caller: box.seats.builder.id }).buildOffer.seat,
    box.seats.builder.id, 'a different free caller still receives the main-red build');
  const resumed = await cli(box, box.seats.outside.path, ['next', '--take']);
  assert.equal(resumed.code, 0, resumed.out + resumed.err);
  assert.equal(resumed.document.item.item_id, review);
  assert.equal(resumed.document.review, true);
  assert.equal(store.getItem(box.board, review).item_review_by, box.seats.outside.id);
  assert.equal(store.getItem(box.board, old).item_owner, box.seats.actor.id);
  const before = exportBoard(box.board);
  const offered = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(offered.code, 0, offered.out + offered.err);
  assert.equal(offered.document.buildOffer.seat, box.seats.builder.id);
  assert.equal(offered.document.buildOffer.item, repair);
  assert.equal(offered.document.releaseRequest, undefined);
  assert.deepEqual(exportBoard(box.board), before, 'default next does not claim another seat or release its caller');
  const taken = await cli(box, box.seats.builder.path, ['next', '--take']);
  assert.equal(taken.code, 0, taken.out + taken.err);
  assert.equal(taken.document.item.item_id, repair);
  assert.equal(store.getItem(box.board, repair).item_owner, box.seats.builder.id);
  assert.equal(store.getItem(box.board, old).item_owner, box.seats.actor.id);
  const followup = box.add('Further repair of the measured failure', { brief: 'Files: web/followup.js' });
  const occupied = exportBoard(box.board);
  const requested = await cli(box, box.seats.actor.path, ['next']);
  assert.equal(requested.code, 0, requested.out + requested.err);
  assert.equal(requested.document.releaseRequest, undefined, 'current routing cannot preempt a build without explicit waiting evidence');
  assert.equal(requested.document.item.item_id, old, 'the caller resumes its protected current work');
  assert.equal(requested.document.buildOffer, undefined);
  assert.deepEqual(exportBoard(box.board), occupied, 'a default-next request never releases the selected newest build');
}
