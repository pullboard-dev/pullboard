/** A running pullboard test says where it was admitted and reports progress each minute [C7,#3439]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { announceTestRun } from '../../../src/logic/test/progress.js';

/** A simulated clock and timer: tick(ms) advances time and fires every interval that falls due. */
function simulated() {
  const state = { time: 0, lines: [], interval: null, cleared: false };
  const say = line => state.lines.push(line);
  const setTimer = (fn, ms) => { state.interval = { fn, ms, next: ms }; return state.interval; };
  const clearTimer = () => { state.cleared = true; };
  const tick = ms => {
    const end = state.time + ms;
    while (!state.cleared && state.interval.next <= end) { state.time = state.interval.next; state.interval.next += state.interval.ms; state.interval.fn(); }
    state.time = end;
  };
  return { state, say, setTimer, clearTimer, tick, now: () => state.time };
}

test('gate.logic-test-progress.a-test-run-prints-its: clause 1: a test run prints its admission and runner [C7]', () => {
  const sim = simulated();
  announceTestRun(sim.say, { host: 'runner-54', files: ['test/a.test.js', 'test/b.test.js'], now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer });
  assert.equal(sim.state.lines.length, 1);
  assert.match(sim.state.lines[0], /admitted on runner-54/);
  assert.match(sim.state.lines[0], /2 files/);
  assert.match(sim.state.lines[0], /test\/a\.test\.js, test\/b\.test\.js/);
});

test('gate.logic-test-progress.a-running-test-prints-a: clause 2: a running test prints a progress line every 60 s [C7]', () => {
  const sim = simulated();
  const stop = announceTestRun(sim.say, { host: 'runner-54', files: ['test/a.test.js'], now: sim.now, setTimer: sim.setTimer, clearTimer: sim.clearTimer });
  assert.equal(sim.state.interval.ms, 60_000);
  sim.tick(59_000);
  assert.equal(sim.state.lines.length, 1);
  sim.tick(181_000);
  const progress = sim.state.lines.slice(1);
  assert.equal(progress.length, 4);
  assert.match(progress[0], /60s elapsed, 1 file running/);
  assert.match(progress[3], /240s elapsed/);
  stop();
  assert.equal(sim.state.cleared, true);
  sim.tick(120_000);
  assert.equal(sim.state.lines.length, 5);
});
