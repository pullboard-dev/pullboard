/** Active light seats keep their ready work while mid and strong seats use their own queue first [N2,B13]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../packages/store/index.js';
import { fixture } from './next-take-fixture.js';
import { main } from './native-cli-fixture.js';

/** Capture the ordinary human-facing output of `next` for one real fixture seat. */
async function runNext(box, cwd) {
  let out = '', err = '';
  const code = await main(['next'], { cwd, clock: box.clock,
    stdout: { isTTY: false, write: text => { out += text; } },
    stderr: { write: text => { err += text; } } });
  return { code, out, err };
}

/** Give each candidate a disjoint file so the queue's normal collision guard stays active. */
function brief(file) {
  return `Files: web/${file}.js\nTest: the selected route owns its ready work.`;
}

/** A successful native next claim carries autoNextSnapshot, unlike a manual claim. */
async function lightSeatRunsNext(box) {
  const task = box.add('Light seat activity', { route: 'light', brief: brief('light-seat-activity') });
  const result = await runNext(box, box.seats.actor.path);
  assert.equal(result.code, 0, result.out + result.err);
  const event = store.events(box.board).find(entry => entry.event_by === box.seats.actor.id
    && entry.event_kind === 'claim' && JSON.parse(entry.event_detail).autoNextSnapshot);
  assert.ok(event, 'the light seat recorded a claim made by next');
  return task;
}

/** An empty native next records the existing next-idle event used by the activity window. */
async function lightSeatRunsIdleNext(box) {
  const before = store.events(box.board).length;
  await runNext(box, box.seats.actor.path);
  assert.ok(store.events(box.board).slice(before).some(event => event.event_by === box.seats.actor.id
    && event.event_kind === 'next-idle'), 'the light seat recorded an empty-next observation');
}

test('active light work stays behind ready mid and strong work even when light is prioritized [N2,B13]', async t => {
  const box = await fixture(t, { route: 'light' });
  await lightSeatRunsNext(box);
  const strong = box.add('Strong work', { route: 'strong', brief: brief('strong-work') });
  const mid = box.add('Mid work', { route: 'mid', brief: brief('mid-work') });
  const light = box.add('Prioritized light work', { route: 'light', brief: brief('prioritized-light') });
  const midSeat = store.register(box.board, { lane: 'web', path: join(box.root, 'mid-seat'), route: 'mid' });

  const strongPick = store.nextFor(box.board, { agentId: box.seats.builder.id, lane: 'web', priority: [light] });
  assert.equal(strongPick.item.item_id, strong, 'ready strong work wins over a deliberately prioritized light item');
  assert.equal(strongPick.lightReserved.item_id, light);
  const midPick = store.nextFor(box.board, { agentId: midSeat, lane: 'web', priority: [light] });
  assert.equal(midPick.item.item_id, mid, 'ready mid work also wins over a deliberately prioritized light item');
  assert.equal(midPick.lightReserved.item_id, light);

  const result = await runNext(box, box.seats.builder.path);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, new RegExp(`claimed #${strong}:`), result.out);
  assert.match(result.out, new RegExp(`kept #${light} for active light seats`), result.out);
});

test('an active light seat does not block fallback when no strong work is ready [N2,B13]', async t => {
  const box = await fixture(t, { route: 'light' });
  await lightSeatRunsNext(box);
  const light = box.add('Only ready light work', { route: 'light', brief: brief('only-light') });

  const result = await runNext(box, box.seats.builder.path);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, new RegExp(`claimed #${light}:`), result.out);
  assert.doesNotMatch(result.out, /kept #\d+ for active light seats/u);
});

test('light work is available freely after the light seat has been quiet for 30 minutes [N2,B13]', async t => {
  const box = await fixture(t, { route: 'light' });
  await lightSeatRunsNext(box);
  box.advance(31 * 60_000);
  const light = box.add('Light work after the quiet window', { route: 'light', brief: brief('quiet-light') });

  const result = await runNext(box, box.seats.builder.path);
  assert.equal(result.code, 0, result.out + result.err);
  assert.match(result.out, new RegExp(`claimed #${light}:`), result.out);
  assert.doesNotMatch(result.out, /kept #\d+ for active light seats/u);
});

test('an empty next observation counts as light-seat activity, but a manual claim does not [N2,B13]', async t => {
  const box = await fixture(t, { route: 'light' });
  await lightSeatRunsIdleNext(box);
  const strong = box.add('Strong work', { route: 'strong', brief: brief('idle-strong') });
  const light = box.add('Prioritized light work', { route: 'light', brief: brief('idle-light') });
  assert.equal(store.nextFor(box.board, { agentId: box.seats.builder.id, lane: 'web', priority: [light] }).item.item_id, strong,
    'the existing next-idle event activates the reservation');

  const manualBox = await fixture(t, { route: 'light' });
  const manual = manualBox.add('Manual light claim', { route: 'light', brief: brief('manual-claim') });
  manualBox.claim(manual, manualBox.seats.actor);
  const manualStrong = manualBox.add('Strong work', { route: 'strong', brief: brief('manual-strong') });
  const manualLight = manualBox.add('Prioritized light work', { route: 'light', brief: brief('manual-light') });
  assert.equal(store.nextFor(manualBox.board, { agentId: manualBox.seats.builder.id, lane: 'web', priority: [manualLight] }).item.item_id, manualLight,
    'a manual claim without autoNextSnapshot is not mistaken for a next invocation');
  assert.equal(store.getItem(manualBox.board, manualStrong).item_status, 'open');
});

test('a light seat review reservation also counts as next activity [N2,B13]', async t => {
  const box = await fixture(t, { route: 'light' });
  const reviewerPath = join(box.root, 'light-review-seat');
  const reviewer = store.register(box.board, { lane: 'review', path: reviewerPath, route: 'light', family: 'Family Beta' });
  const submitted = box.add('Submission for the light reviewer', { route: 'light', brief: brief('reviewed-light') });
  box.submit(submitted);
  const reservation = store.reserveNextReview(box.board, { agentId: reviewer, lane: 'review', leaseMs: 60_000, policy: 'any' });
  assert.equal(reservation.item.item_id, submitted);

  const strong = box.add('Strong work', { route: 'strong', brief: brief('review-next-strong') });
  const light = box.add('Prioritized light work', { route: 'light', brief: brief('review-next-light') });
  const picked = store.nextFor(box.board, { agentId: box.seats.builder.id, lane: 'web', priority: [light] });
  assert.equal(picked.item.item_id, strong, 'the canonical reserve event counts for a light seat that ran next --verify');
});
