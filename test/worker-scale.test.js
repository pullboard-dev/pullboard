/** The board runs as many workers as are worth running, within the person's one seat-hour budget [B26,C7]. */
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { parseWorkerBudget } from '../src/settings.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { observeWorkers } from '../src/worker-scale.js';
import { planWorkerScale } from '../src/worker-scale.js';
import { scaleCycle } from '../src/worker-scale.js';
import { seatHoldsWork } from '../src/worker-scale.js';
import { windowStart } from '../src/worker-scale.js';
import { workerLedger } from '../src/worker-scale.js';

const HOUR = 3_600_000;

/**
 * A simulated board: queued reviews and builds, the scaler's managed seats, and optionally a seat someone else
 * started. Each cycle every live seat spends cycleHours of the budget; a free seat takes a review first, else a
 * build, and finishes it within the cycle. The ports are the ones the real supervisor drives.
 */
function simulatedBoard({ budget, cycleHours = 0.5, worth = () => null, outside = null }) {
  const sim = { reviews: 0, builds: 0, seats: new Map(), next: 1, used: 0, log: [], outside };
  if (outside) sim.seats.set(outside.id, { managed: false, holding: true });
  sim.ports = {
    observe: () => ({ budget, usedHours: sim.used, cycleHours, worth: worth(sim), reviews: sim.reviews, builds: sim.builds,
      workers: [...sim.seats].map(([id, seat]) => ({ id, busy: seat.holding, managed: seat.managed })) }),
    isIdle: id => !sim.seats.get(id).holding,
    stop: id => {
      const seat = sim.seats.get(id);
      assert.ok(seat.managed && !seat.holding, `${id} is stopped only while it is the scaler's own idle seat`);
      sim.seats.delete(id);
      sim.log.push(['stop', id]);
    },
    launch: () => { const id = `w${sim.next++}`; sim.seats.set(id, { managed: true, holding: false }); sim.log.push(['launch', id]); },
  };
  /** Run one cycle of work: draw down every live seat, then free seats pull reviews first and finish in the cycle. */
  sim.work = (cycle) => {
    sim.used += sim.seats.size * cycleHours;
    for (const [id, seat] of sim.seats) {
      if (!seat.managed) {
        if (cycle >= sim.outside.releaseAt) sim.seats.delete(id); // The outside session finishes its claim and leaves.
        continue;
      }
      if (sim.reviews) { sim.reviews -= 1; sim.log.push(['review', id]); }
      else if (sim.builds) { sim.builds -= 1; sim.log.push(['build', id]); }
    }
  };
  return sim;
}

test('a growing queue raises workers to what the budget pays for and the budget is never exceeded; held work is never stopped [B26,C7]', async () => {
  const budget = parseWorkerBudget('20/day');
  const sim = simulatedBoard({ budget, outside: { id: 'person-seat', releaseAt: 3 } });
  const plans = [];
  for (let cycle = 0; cycle < 24; cycle += 1) {
    sim.builds += cycle + 1; // Arrivals grow every cycle, faster than the seats drain them.
    if (cycle % 2) sim.reviews += 1;
    const plan = await scaleCycle(sim.ports);
    assert.ok(!plan.stopped.includes('person-seat'), 'a seat holding a claim that the scaler did not start is never stopped');
    assert.ok(sim.seats.size * 0.5 <= Math.max(0, budget.seatHours - sim.used) + 1e-9,
      `cycle ${cycle}: ${sim.seats.size} seats would spend past the ${budget.seatHours - sim.used} seat-hours left`);
    plans.push({ ...plan, after: sim.seats.size });
    sim.work(cycle);
    assert.ok(sim.used <= budget.seatHours + 1e-9, `cycle ${cycle}: ${sim.used} seat-hours exceed the budget of ${budget.seatHours}`);
  }
  assert.ok(plans.some(plan => plan.binding === 'budget' && plan.after === plan.affordable && plan.after > 1),
    `the growing queue raised the count until the budget bound it: ${plans.map(plan => plan.after)}`);
  assert.ok(plans.slice(0, 3).every((plan, index) => !index || plan.after >= plans[index - 1].after), 'the count rose while the queue grew');
  assert.equal(plans.at(-1).after, 0, 'a spent budget lowers the count to zero while work still waits');
  assert.ok(sim.reviews === 0 || sim.log.filter(([kind]) => kind === 'review').length > 0, 'waiting reviews were taken');
});

test('an empty queue lowers the count with budget left, and K binds below the budget [B26,C7]', async () => {
  const sim = simulatedBoard({ budget: parseWorkerBudget('200/week'), worth: () => 3 });
  const counts = [];
  for (let cycle = 0; cycle < 10; cycle += 1) {
    if (cycle < 3) sim.builds += 6;
    const plan = await scaleCycle(sim.ports);
    if (cycle === 0) assert.equal(plan.binding, 'worth', 'K=3 binds below a budget that pays for hundreds');
    counts.push(sim.seats.size);
    sim.work(cycle);
  }
  assert.equal(Math.max(...counts), 3, `K caps the count: ${counts}`);
  assert.equal(counts.at(-1), 0, `the drained queue lowered the count with budget left: ${counts}`);
  assert.ok(sim.log.some(([kind]) => kind === 'stop'), 'scaling down stopped idle workers');
});

test('held seats and seats started elsewhere are never chosen to stop, and reviews are assigned first [B26,C7]', async () => {
  const budget = parseWorkerBudget('10/day');
  const held = planWorkerScale({ budget, usedHours: 10, cycleHours: 1, worth: 0, reviews: 0, builds: 0,
    workers: [{ id: 'a', busy: true, managed: true }, { id: 'b', busy: false, managed: false }, { id: 'c', busy: false, managed: true }] });
  assert.equal(held.affordable, 0, 'a spent budget pays for no seat');
  assert.deepEqual(held.stop, ['c'], 'only the scaler\'s own idle seat stops; held and outside seats keep running');
  assert.equal(held.launch, 0);
  const first = planWorkerScale({ budget, usedHours: 0, cycleHours: 1, worth: null, reviews: 2, builds: 5, workers: [] });
  assert.deepEqual(first.assign, { review: 2, build: 5 }, 'every waiting item gets a seat when the budget allows');
  const tight = planWorkerScale({ budget: parseWorkerBudget('3/day'), usedHours: 0, cycleHours: 1, worth: null, reviews: 2, builds: 5, workers: [] });
  assert.deepEqual(tight.assign, { review: 2, build: 1 }, 'with three affordable seats the waiting reviews are assigned before builds');
  assert.equal(first.worthKnown, false, 'an unknown K is labelled, and the waiting work stands in for it');
  const late = await scaleCycle({ observe: () => ({ budget, usedHours: 10, cycleHours: 1, worth: 0, reviews: 0, builds: 0, workers: [{ id: 'w9', busy: false, managed: true }] }),
    isIdle: () => false, stop: () => assert.fail('a seat that took work after the observation was stopped'), launch: () => assert.fail('nothing to launch') });
  assert.deepEqual(late.stopped, [], 'the re-check just before stopping keeps a seat that took work');
  assert.throws(() => parseWorkerBudget('4'), /seat-hours per day or week/u, 'a bare seat count is not a budget');
});

test('the machine ledger draws down every live seat per window and refuses an unreadable record [B26,C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-worker-ledger-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'workers-usage.json');
  const ledger = workerLedger(file);
  const start = windowStart('day', Date.parse('2026-10-28T15:00:00Z'));
  assert.equal(start, Date.parse('2026-10-28T00:00:00Z'));
  assert.equal(windowStart('week', Date.parse('2026-10-28T15:00:00Z')), Date.parse('2026-10-26T00:00:00Z'), 'a week starts on Monday UTC');
  ledger.record('day', start + 10 * HOUR, 3, 0.5);
  assert.equal(ledger.record('day', start + 10.5 * HOUR, 3, 0.5).usedHours, 1.5, 'three live seats for half an hour spend 1.5 seat-hours');
  assert.equal(ledger.record('day', start + 15 * HOUR, 3, 0.5).usedHours, 4.5, 'an unobserved gap counts at most two cycles');
  assert.equal(ledger.read('day', start + 25 * HOUR).usedHours, 0, 'the next day starts a fresh window');
  writeFileSync(file, '{broken');
  assert.throws(() => ledger.read('day', start + 11 * HOUR), /unreadable/u, 'a damaged ledger never hands out a fresh budget');
});

test('the board observation counts every live local seat and held claims and reviews as busy [B26,C7]', t => {
  let at = Date.parse('2026-10-28T12:00:00Z');
  const board = fixtureBoard(t, { clock: { now: () => new Date(at) } });
  store.register(board, { lane: 'coordinator', path: '/fixture/main' });
  const builder = store.register(board, { lane: 'web', path: '/fixture/builder' });
  const reviewer = store.register(board, { lane: 'web', path: '/fixture/reviewer' });
  const idle = store.register(board, { lane: 'web', path: '/fixture/idle' });
  const freeze = item => ({ text: item.item_title, digest: `synthetic:${item.item_id}` });
  const add = title => store.addItem(board, { by: 'coordinator', lane: 'web', title, brief: `Files: web/${title}.js` });
  const claimed = add('claimed');
  store.claim(board, claimed, { agentId: builder, lane: 'web', leaseMs: 3_600_000, freeze });
  const reviewed = add('reviewed');
  store.claim(board, reviewed, { agentId: idle, lane: 'web', leaseMs: 3_600_000, freeze });
  submitFixture(board, reviewed, { agentId: idle, commit: 'a'.repeat(40), tree: 'a'.repeat(40) });
  store.reserveReview(board, reviewed, { agentId: reviewer, lane: 'web', leaseMs: 3_600_000, policy: 'any' });
  const waiting = add('waiting');
  store.claim(board, waiting, { agentId: idle, lane: 'web', leaseMs: 3_600_000, freeze });
  submitFixture(board, waiting, { agentId: idle, commit: 'b'.repeat(40), tree: 'b'.repeat(40) });
  add('ready');
  at += 1000;
  assert.equal(seatHoldsWork(board, builder), true, 'a claim holds its seat');
  assert.equal(seatHoldsWork(board, reviewer), true, 'a review reservation holds its seat');
  assert.equal(seatHoldsWork(board, idle), false, 'a seat whose work is submitted is idle');
  const observed = observeWorkers(board, { lane: 'web', managed: [builder, reviewer, idle], now: at });
  assert.deepEqual(observed.workers.map(worker => worker.busy), [true, true, false]);
  assert.equal(observed.reviews, 1, 'only the unreserved submission waits for a review');
  assert.equal(observed.builds, 1, 'the open ready item waits for a build');
  const plan = planWorkerScale({ ...observed, worth: 2, budget: parseWorkerBudget('40/day'), usedHours: 0, cycleHours: 1 });
  assert.deepEqual(plan.stop, [idle], 'K below the busy seats stops the idle seat only');
});
