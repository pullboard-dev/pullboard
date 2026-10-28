/** The board runs as many workers as are worth running, within the person's one budget [B26,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../src/board.js';
import { fixtureBoard } from './board-fixture.js';
import { submitFixture } from './board-submit-fixture.js';
import { observeWorkers, planWorkerScale, scaleCycle, seatHoldsWork } from '../src/worker-scale.js';

/**
 * A simulated board: queued reviews and builds, and worker seats that take a review first, else a build, and
 * hold it for a fixed number of ticks. Its ports are the ones the real supervisor drives.
 */
function simulatedBoard({ budget, worth = () => null, holdTicks = 2 }) {
  const sim = { reviews: 0, builds: 0, seats: new Map(), next: 1, log: [] };
  const ports = {
    observe: () => ({ budget, worth: worth(sim), reviews: sim.reviews, builds: sim.builds,
      workers: [...sim.seats].map(([id, seat]) => ({ id, busy: seat.left > 0 })) }),
    isIdle: id => sim.seats.get(id).left === 0,
    stop: id => { assert.equal(sim.seats.get(id).left, 0, `${id} is stopped only while idle`); sim.seats.delete(id); sim.log.push(['stop', id]); },
    launch: () => { const id = `w${sim.next++}`; sim.seats.set(id, { left: 0, kind: null }); sim.log.push(['launch', id]); },
  };
  /** Advance one tick: busy seats work down, then free seats pull through dispatch order, reviews first. */
  sim.tick = () => {
    for (const seat of sim.seats.values()) if (seat.left > 0) seat.left -= 1;
    for (const seat of sim.seats.values()) {
      if (seat.left > 0) continue;
      if (sim.reviews) { sim.reviews -= 1; seat.left = holdTicks; seat.kind = 'review'; }
      else if (sim.builds) { sim.builds -= 1; seat.left = holdTicks; seat.kind = 'build'; }
    }
  };
  sim.ports = ports;
  return sim;
}

test('a growing queue raises workers to the budget, an empty queue lowers them, held work is never stopped [B26,C7]', async () => {
  const budget = 4;
  const sim = simulatedBoard({ budget });
  const counts = [];
  // The queue grows for six cycles, then nothing new arrives and it drains.
  for (let cycle = 0; cycle < 20; cycle += 1) {
    if (cycle < 6) { sim.builds += 2; if (cycle % 2) sim.reviews += 1; }
    const busyBefore = new Set([...sim.seats].filter(([, seat]) => seat.left > 0).map(([id]) => id));
    const plan = await scaleCycle(sim.ports);
    for (const id of plan.stopped) assert.ok(!busyBefore.has(id), `${id} held a claim or review and was stopped`);
    assert.ok(sim.seats.size <= budget, `cycle ${cycle}: ${sim.seats.size} workers exceed the budget of ${budget}`);
    counts.push(sim.seats.size);
    sim.tick();
  }
  assert.ok(counts.slice(0, 6).every((count, index) => !index || count >= counts[index - 1]), `the growing queue never lowered the count: ${counts}`);
  assert.equal(Math.max(...counts), budget, `the growing queue raised the count to the budget: ${counts}`);
  assert.equal(counts.at(-1), 0, `the drained queue lowered the count to zero: ${counts}`);
  assert.ok(sim.log.some(([kind]) => kind === 'stop'), 'scaling down stopped idle workers');
});

test('the worth-running count binds below the budget and a held seat survives a lower target [B26,C7]', async () => {
  const sim = simulatedBoard({ budget: 10, worth: () => 3 });
  sim.builds = 20;
  await scaleCycle(sim.ports);
  assert.equal(sim.seats.size, 3, 'K=3 worth running launches three of a budget of ten');
  sim.tick();
  // Every seat now holds work; a target of zero cannot stop any of them.
  const held = planWorkerScale({ budget: 10, worth: 0, reviews: 0, builds: 0, workers: [...sim.seats.keys()].map(id => ({ id, busy: true })) });
  assert.deepEqual(held.stop, [], 'no seat holding a claim or review is chosen to stop');
  assert.equal(held.launch, 0);
  // A seat that took work after the observation is re-checked and kept.
  const late = await scaleCycle({ observe: () => ({ budget: 1, worth: 0, reviews: 0, builds: 0, workers: [{ id: 'w9', busy: false }] }),
    isIdle: () => false, stop: () => assert.fail('a seat that took work after the observation was stopped'), launch: () => assert.fail('nothing to launch') });
  assert.deepEqual(late.stopped, []);
});

test('free seats take reviews first and the budget bounds every plan [B26,C7]', () => {
  const plan = planWorkerScale({ budget: 3, worth: null, reviews: 2, builds: 5, workers: [] });
  assert.equal(plan.launch, 3);
  assert.deepEqual(plan.assign, { review: 2, build: 1 }, 'waiting reviews are assigned before builds');
  assert.equal(plan.binding, 'budget');
  assert.equal(plan.worthKnown, false, 'an unknown K is labelled, and the waiting work stands in for it');
  const over = planWorkerScale({ budget: 2, worth: 9, reviews: 9, builds: 9,
    workers: [{ id: 'a', busy: true }, { id: 'b', busy: false }, { id: 'c', busy: false }] });
  assert.deepEqual(over.stop, ['c'], 'a lowered budget stops only idle seats, down to the budget');
  assert.equal(over.launch, 0);
  assert.throws(() => planWorkerScale({ budget: -1, worth: 1, reviews: 0, builds: 0, workers: [] }), TypeError);
});

test('the board observation counts held claims and review reservations as busy seats [B26,C7]', t => {
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
  const observed = observeWorkers(board, { budget: 5, lane: 'web', seats: [builder, reviewer, idle], now: at });
  assert.deepEqual(observed.workers.map(worker => worker.busy), [true, true, false]);
  assert.equal(observed.reviews, 1, 'only the unreserved submission waits for a review');
  assert.equal(observed.builds, 1, 'the open ready item waits for a build');
  const plan = planWorkerScale({ ...observed, worth: 2 });
  assert.deepEqual(plan.stop, [idle], 'K below the busy seats stops the idle seat only');
});
