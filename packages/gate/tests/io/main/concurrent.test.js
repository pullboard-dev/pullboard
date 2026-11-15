/** Gate stages start together; the gate lasts as long as its slowest stage, and a red stage stops the rest [C7]. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { runGateStages } from '../../../index.js';

/**
 * Stages on a driven clock: each records when it started and ends only when the test releases it, or when the
 * gate's signal aborts. Why: a driven clock proves start-together and slowest-stage timing without wall-clock margins.
 */
function drivenStages(names) {
  const clock = { now: 0 };
  const started = {}, release = {}, stopped = [];
  const stages = names.map(name => ({
    name,
    run: (signal) => new Promise((resolve, reject) => {
      started[name] = clock.now;
      const stop = () => { stopped.push(name); reject(signal.reason); };
      const finish = action => { signal.removeEventListener('abort', stop); action(); };
      release[name] = { green: () => finish(() => resolve(`${name} green`)), red: () => finish(() => reject(new Error(`${name} is red`))) };
      signal.addEventListener('abort', stop, { once: true });
    }),
  }));
  return { clock, started, release, stopped, stages };
}

/** Let every stage the gate started reach its own work. */
async function settle() {
  for (let turn = 0; turn < 5; turn++) await Promise.resolve();
}

test('three stages of 2, 3 and 4 s finish in about 4 s, not 9 s [C7]', async () => {
  const durations = { static: 2_000, cells: 3_000, tests: 4_000 };
  const run = drivenStages(Object.keys(durations));
  const rows = [];
  const gate = runGateStages(run.stages, { onStage: row => rows.push(row), now: () => run.clock.now });
  await settle();
  assert.deepEqual(run.started, { static: 0, cells: 0, tests: 0 }, 'every stage starts before any stage finishes');
  for (const [name, ms] of Object.entries(durations)) {
    run.clock.now = ms;
    run.release[name].green();
    await settle();
  }
  assert.deepEqual(await gate, { static: 'static green', cells: 'cells green', tests: 'tests green' });
  const sum = Object.values(durations).reduce((total, ms) => total + ms, 0);
  const slowest = Math.max(...Object.values(durations));
  assert.equal(rows.at(-1).ms, slowest, 'the gate takes as long as its slowest stage');
  assert.notEqual(rows.at(-1).ms, sum, 'the gate never takes the sum of its stages');
  assert.deepEqual(rows.map(row => [row.name, row.green]), [['static', true], ['cells', true], ['tests', true]]);
});

test('the first red stage cancels the others and refuses at once [C7]', async () => {
  const run = drivenStages(['static', 'cells', 'tests']);
  const gate = runGateStages(run.stages, { now: () => run.clock.now });
  await settle();
  run.clock.now = 1_000;
  run.release.static.red();
  // cells and tests are never released: the gate refuses only because the red stage cancelled them.
  await assert.rejects(gate, /static is red/u);
  assert.deepEqual(run.stopped.sort(), ['cells', 'tests'], 'every still-running stage receives the cancel');
});

