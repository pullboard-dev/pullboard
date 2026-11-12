/** Under gate.runnersOnly a companion's baseline check never runs on this machine [C7,E28,B12]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { fileFixtureItem } from '../../fixtures/testkit.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

/** File a parent, claim it, and request a companion carrying a check that leaves a marker if it ever runs locally. */
async function request(runnersOnly) {
  const box = helpers.project('true');
  const machine = join(box.dir, 'machine-home');
  mkdirSync(machine, { recursive: true });
  fixtureMachineSettings(machine, { gate: { runnersOnly, runnerWaitMs: 100 } });
  const marker = join(box.dir, 'check-ran');
  const parent = fileFixtureItem(box, box.repo, { lane: 'web', title: 'Parent', criterion: 'needs the API', args: ['--specs', 'G1'] }).item_id;
  // Only the coordinator (the main checkout) supplies a check.
  const made = await box.inProcess(box.repo, 'companion', String(parent), 'api', 'Provide the API', '--key', 'api-part',
    '--criterion', 'the API serves this parent [test]', '--specs', 'G2', '--route', 'strong',
    '--check', `touch '${marker}'`, '--json');
  return { made, marker, box };
}

test('with gate.runnersOnly set, companion never runs checkBaseline on this machine [C7,E28]', async () => {
  const { made, marker } = await request(true);
  // A local run would have created the marker before the command returned.
  assert.equal(existsSync(marker), false, `the check ran locally: ${made.err}${made.out}`);
  assert.equal(made.code, 0, made.err + made.out);
});

test('the check runs through the runner worker or refuses with a next step under gate.runnersOnly [C7,E28]', async () => {
  const { made } = await request(true);
  if (made.code === 0) {
    const baseline = JSON.parse(made.out).item.item_check_baseline;
    assert.ok(['pending', 'unavailable'].includes(baseline?.result), `baseline is ${baseline?.result}, not measured here`);
  } else assert.match(made.err + made.out, /"next"|next:/u, 'a refusal names its next step');
});

test('without gate.runnersOnly the baseline still runs on this machine as before [C7]', async () => {
  const { made, marker } = await request(false);
  assert.equal(made.code, 0, made.err + made.out);
  assert.equal(existsSync(marker), true);
});
