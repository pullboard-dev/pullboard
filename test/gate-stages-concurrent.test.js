/** Gate stages start together; the gate lasts as long as its slowest stage, and a red stage stops the rest [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runGateStages } from '../packages/gate/index.js';

/** A stage that is green after `ms`, or stops at once when the gate's signal aborts. */
function timedStage(name, ms, { red = false, stopped = [] } = {}) {
  return {
    name,
    run: (signal) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => (red ? reject(new Error(`${name} is red`)) : resolve(`${name} green`)), ms);
      signal.addEventListener('abort', () => { clearTimeout(timer); stopped.push(name); reject(signal.reason); }, { once: true });
    }),
  };
}

test('three stages of 2, 3 and 4 s finish in about 4 s, not 9 s [C7]', { timeout: 30_000 }, async () => {
  const rows = [];
  const started = performance.now();
  const results = await runGateStages([timedStage('static', 2_000), timedStage('cells', 3_000), timedStage('tests', 4_000)],
    { onStage: row => rows.push(row) });
  const elapsed = performance.now() - started;
  assert.deepEqual(results, { static: 'static green', cells: 'cells green', tests: 'tests green' });
  assert.ok(elapsed >= 3_900 && elapsed < 6_000, `the gate takes its slowest stage, about 4 s; took ${Math.round(elapsed)} ms`);
  assert.deepEqual(rows.map(row => [row.name, row.green]), [['static', true], ['cells', true], ['tests', true]]);
});

test('the first red stage cancels the others and refuses at once [C7]', { timeout: 30_000 }, async () => {
  const stopped = [];
  const started = performance.now();
  await assert.rejects(runGateStages([timedStage('static', 1_000, { red: true }), timedStage('cells', 3_000, { stopped }),
    timedStage('tests', 4_000, { stopped })]), /static is red/u);
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2_500, `the red stage ends the gate at about 1 s; took ${Math.round(elapsed)} ms`);
  assert.deepEqual(stopped.sort(), ['cells', 'tests'], 'every still-running stage receives the cancel');
});

test('submit starts static, cells, doctrine and the test gate together [C7]', () => {
  const source = readFileSync(new URL('../src/commands/submit.js', import.meta.url), 'utf8');
  const call = source.slice(source.indexOf('await runGateStages('));
  assert.ok(source.includes('await runGateStages('), 'submit runs its gate stages through runGateStages');
  for (const name of ['static', 'cells', 'doctrine', 'tests']) assert.match(call.slice(0, 6_000), new RegExp(`name: '${name}'`, 'u'));
});
