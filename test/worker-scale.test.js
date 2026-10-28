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

/** A private ledger file per case, so each adversarial history starts from a known record. */
function ledgerFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-worker-ledger-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, 'workers-usage.json');
  return { file, ledger: workerLedger(file), write: value => writeFileSync(file, JSON.stringify(value)) };
}
const DAY = Date.parse('2026-10-28T00:00:00Z');
const at = hours => DAY + hours * HOUR;

test('counterexample: an unobserved hour with one held seat spends a 1/day budget and launches nothing [B26,C7]', t => {
  const { ledger, write } = ledgerFixture(t);
  // The ledger's last sample was 12:00 with one live seat holding a claim; the next record comes at 13:00.
  write({ window: 'day', start: DAY, usedHours: 0, sampledAt: at(12), seats: ['held'], spent: null });
  const used = ledger.record('day', at(13), ['held']);
  assert.equal(used.usedHours, 1, 'the full unobserved hour is charged for the seat live at both ends, never capped at two cycles');
  const plan = planWorkerScale({ budget: parseWorkerBudget('1/day'), usedHours: used.usedHours, cycleHours: 1 / 60, worth: null,
    reviews: 1, builds: 2, workers: [{ id: 'held', busy: true, managed: false }] });
  assert.equal(plan.leftHours, 0);
  assert.equal(plan.launch, 0, 'a spent budget launches no new seat');
  assert.deepEqual(plan.stop, [], 'and the held seat keeps running');
});

test('the ledger charges every seat seen at either end of a gap, in full, and survives a supervisor restart [B26,C7]', t => {
  const { file, ledger, write } = ledgerFixture(t);
  write({ window: 'day', start: DAY, usedHours: 2, sampledAt: at(9), seats: ['a', 'b'], spent: null });
  // b stopped somewhere in the gap and c started somewhere in it; neither moment was observed.
  assert.equal(ledger.record('day', at(12), ['a', 'c']).usedHours, 2 + 3 * 3, 'a, b and c are each charged the whole three hours');
  const restarted = workerLedger(file); // A new supervisor process reads the same machine ledger.
  assert.equal(restarted.read('day', at(12)).usedHours, 11, 'a restart keeps the window\'s use');
  assert.equal(restarted.record('day', at(12.5), ['a']).usedHours, 11 + 2 * 0.5, 'a and c, live at the ends of the half hour, are charged');
  assert.equal(restarted.record('day', at(12.5), ['a']).usedHours, 12, 'an immediate repeat sample adds nothing');
});

test('a missing ledger charges the seats live now from the window start [B26,C7]', t => {
  const { ledger } = ledgerFixture(t);
  assert.equal(ledger.record('day', at(18), ['a', 'b']).usedHours, 36, 'nothing proves when two seats live at 18:00 began, so both are charged from midnight');
  assert.equal(ledgerFixture(t).ledger.record('day', at(18), []).usedHours, 0, 'with no live seat there is nothing to charge');
});

test('a day or week rollover charges only the new window, from its start [B26,C7]', t => {
  const { ledger, write } = ledgerFixture(t);
  write({ window: 'day', start: DAY - 24 * HOUR, usedHours: 30, sampledAt: at(-0.5), seats: ['a', 'b'], spent: null });
  assert.equal(ledger.record('day', at(0.5), ['a']).usedHours, 1, 'a and b may have run since midnight: half an hour each in the new day');
  assert.equal(windowStart('week', at(15)), Date.parse('2026-10-26T00:00:00Z'), 'a week starts on Monday UTC');
  assert.equal(windowStart('week', Date.parse('2026-10-26T00:00:00Z')), Date.parse('2026-10-26T00:00:00Z'), 'Monday midnight starts its own week');
  assert.equal(windowStart('week', Date.parse('2026-10-25T23:59:59Z')), Date.parse('2026-10-19T00:00:00Z'), 'Sunday belongs to the week before');
});

test('a clock that moves backwards treats the budget as spent for the window and names why [B26,C7]', t => {
  const { ledger, write } = ledgerFixture(t);
  write({ window: 'day', start: DAY, usedHours: 1, sampledAt: at(14), seats: ['a'], spent: null });
  const back = ledger.record('day', at(13), ['a']);
  assert.equal(back.usedHours, Infinity);
  assert.match(back.spent, /clock moved backwards/u);
  assert.equal(ledger.record('day', at(15), ['a']).usedHours, Infinity, 'the window stays spent after the clock recovers');
  const plan = planWorkerScale({ budget: parseWorkerBudget('100/day'), usedHours: back.usedHours, spent: back.spent, cycleHours: 1, worth: 5, reviews: 3, builds: 3, workers: [] });
  assert.equal(plan.launch, 0, 'nothing launches in a spent window');
  assert.equal(ledger.record('day', at(25), ['a']).spent, null, 'the next day starts clean');
  const across = ledgerFixture(t);
  across.write({ window: 'day', start: DAY + 24 * HOUR, usedHours: 0, sampledAt: at(25), seats: [], spent: null });
  assert.match(across.ledger.record('day', at(23), []).spent, /clock moved backwards/u, 'a clock behind the ledger\'s window is spent too');
  assert.equal(across.ledger.read('day', at(23)).usedHours, Infinity);
});

test('an unreadable or malformed ledger refuses instead of granting a fresh budget [B26,C7]', t => {
  const { file, ledger, write } = ledgerFixture(t);
  writeFileSync(file, '{broken');
  assert.throws(() => ledger.record('day', at(11), []), /unreadable/u);
  for (const value of [{ window: 'day', start: DAY, usedHours: -1, sampledAt: at(1), seats: [], spent: null },
    { window: 'day', start: DAY, usedHours: 1, sampledAt: at(1), seats: 'a', spent: null },
    { window: 'month', start: DAY, usedHours: 1, sampledAt: at(1), seats: [], spent: null }, null]) {
    write(value);
    assert.throws(() => ledger.read('day', at(2)), /not a valid record/u, `refuses ${JSON.stringify(value)}`);
  }
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
