/** pullboard runner list names a runner swapping past half its memory and leaves the rest as they were [C7,#10583]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apiHttpFixture } from '../../../tests/fixtures/api.js';
import { runCliInProcess } from '../../../tests/fixtures/process.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';

const AT = '2026-11-19T00:00:00.000Z';
/** Two measured runners with 16 GB; only the first has swapped past half of it. */
const SWAPPING = { host: 'swap-box.example.invalid', slots: 2, browser: 0, cores: 8, memoryMB: 16384, cpuLoad: { at: AT, busyPercent: 5, average: [0.1, 0.1, 0.1], swapUsedMB: 9216 } };
const CALM = { host: 'calm-box.example.invalid', slots: 2, browser: 0, cores: 8, memoryMB: 16384, cpuLoad: { at: AT, busyPercent: 5, average: [0.1, 0.1, 0.1], swapUsedMB: 1024 } };

/** A fixture box whose machine settings register both runners. */
function boxWithRunners(t) {
  const box = apiHttpFixture(t);
  fixtureMachineSettings(box.env.PULLBOARD_MACHINE_HOME, { runners: [SWAPPING, CALM] });
  return box;
}

test('cli.journeys-runner-runners-swap.runner-list-prints-swapping-on-the-runner: clause 1: runner list prints swapping 9.0 GB of 16.0 GB on the runner past half its memory and nothing on the one under it [C7,#10583]', async t => {
  const box = boxWithRunners(t);
  const ran = await runCliInProcess(['runner', 'list'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.equal(ran.stdout.match(/swapping/gu)?.length, 1, 'only one runner is over half');
  const [first, second] = ran.stdout.split(CALM.host);
  assert.match(first, /swapping 9\.0 GB of 16\.0 GB/u);
  assert.doesNotMatch(second, /swapping/u);
});

test('cli.journeys-runner-runners-swap.runner-list-json-carries-swapusedmb-on-that: clause 2: runner list --json carries swapUsedMB on the registered runner row from its cpuLoad [C7,#10583]', async t => {
  const box = boxWithRunners(t);
  const ran = await runCliInProcess(['runner', 'list', '--json'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  const rows = new Map(JSON.parse(ran.stdout).runners.map(row => [row.host, row]));
  assert.equal(rows.get(SWAPPING.host).swapUsedMB, 9216);
  assert.equal(rows.get(CALM.host).swapUsedMB, 1024);
});
