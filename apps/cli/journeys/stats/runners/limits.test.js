/** A change to gateSlots, workers.budget or runner jobs is a timestamped board event that stats runners --json reads back [C7,#6139]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { test } from 'node:test';
import { apiHttpBox } from '../../../tests/fixtures/api.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { fixtureMachineSettings } from '../../../tests/fixtures/testkit.js';

test('changing gateSlots, workers.budget and runner jobs records key, old and new value with a time, and stats runners --json lists them [C7,#6139]', { timeout: 90_000 }, // budget: one private init, an API start and seven CLI calls.
async t => {
  const box = await apiHttpBox(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { gate: { runnerDispatch: 'pull' } });
  const cli = (...argv) => runCliInProcess(argv, { cwd: box.root, env: box.env });
  const board = `${box.origin}${box.path}?k=${box.key}`;
  const before = Date.now();
  for (const argv of [['settings', 'gateSlots', '5'], ['settings', 'gateSlots', '5'], ['settings', 'gateSlots', '6'], ['settings', 'workers.budget', '40/day'], ['settings', 'workers.budget', '60/day'],
    ['runner', 'serve', board, '--once', '--jobs', '2'], ['runner', 'serve', board, '--once', '--jobs', '4']]) {
    const ran = await cli(...argv);
    assert.equal(ran.status, 0, `${argv.join(' ')}: ${ran.stderr}`);
  }
  const stats = await cli('stats', 'runners', '--json');
  assert.equal(stats.status, 0, stats.stderr);
  const { limits } = JSON.parse(stats.stdout).runners;
  assert.deepEqual(limits.map(row => [row.key, row.new]), [['gateSlots', 5], ['gateSlots', 6], ['workers.budget', { spend: 40, window: 'day' }], ['workers.budget', { spend: 60, window: 'day' }], ['runner.jobs', 2], ['runner.jobs', 4]],
    'each real change is one event; setting a value to itself records nothing');
  assert.equal(limits[1].old, 5);
  assert.deepEqual(limits[3].old, { spend: 40, window: 'day' });
  assert.deepEqual([limits[4].old, limits[5].old], [null, 2]);
  assert.ok(limits.every(row => Date.parse(row.at) >= before - 1000 && Date.parse(row.at) <= Date.now() + 1000), 'every event carries the time it was recorded');
});
