/** gate.pullPilot sends named items or a share of items through the pull gate while dispatch stays controller; off is all controller [P7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { jobQueueMode } from '../../../index.js';
import { loadMachineSettings } from '../../../index.js';
import { pullGateFor } from '../../../index.js';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../apps/cli/tests/fixtures/testkit.js';

/** Point the machine home at a private directory holding the given settings, and restore it afterwards. */
function withSettings(settings, work) {
  const { root: dir } = privateFixtureFiles('pullboard-pull-pilot-setting-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    if (settings) fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return work();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

const ITEMS = Array.from({ length: 1000 }, (_, n) => n + 1);
/** The items, of 1..1000, whose submits take the pull gate under these settings. */
const pulled = settings => withSettings(settings, () => ITEMS.filter(item => pullGateFor(item)));

test('clause 1: under controller with the pilot off every submit takes the controller path and the job queue is not served [P7]', () => {
  for (const settings of [{ gate: { runnerDispatch: 'controller' } }, { gate: { runnerDispatch: 'controller', pullPilot: {} } }, { gate: { runnerDispatch: 'controller', pullPilot: { items: [], share: 0 } } }]) {
    assert.deepEqual(pulled(settings), [], `${JSON.stringify(settings)} pulls nothing`);
    assert.equal(withSettings(settings, jobQueueMode), 'controller');
  }
});

test('clause 1: the pilot sends only its named items through the pull gate and serves the job queue for them [P7]', () => {
  const settings = { gate: { runnerDispatch: 'controller', pullPilot: { items: [7, 42] } } };
  assert.deepEqual(pulled(settings), [7, 42]);
  assert.equal(withSettings(settings, jobQueueMode), 'pull', 'runners can take the pilot gate jobs');
});

test('clause 1: a pilot share sends that percentage of items, the same items on every submit [P7]', () => {
  const quarter = pulled({ gate: { runnerDispatch: 'controller', pullPilot: { share: 25 } } });
  assert.ok(quarter.length > 200 && quarter.length < 300, `about a quarter of 1000 items, got ${quarter.length}`);
  assert.deepEqual(pulled({ gate: { runnerDispatch: 'controller', pullPilot: { share: 25 } } }), quarter, 'the share is stable per item, so resubmits keep their path');
  const half = pulled({ gate: { runnerDispatch: 'controller', pullPilot: { share: 50 } } });
  assert.ok(quarter.every(item => half.includes(item)), 'raising the share only adds items');
  assert.deepEqual(pulled({ gate: { runnerDispatch: 'controller', pullPilot: { share: 100 } } }), ITEMS);
  assert.deepEqual(pulled({ gate: { runnerDispatch: 'controller', pullPilot: { items: [3], share: 0 } } }), [3]);
});

test('clause 1: gate.runnerDispatch pull, set or by default, sends every submit through the pull gate [P7]', () => {
  for (const settings of [null, { gate: {} }, { gate: { runnerDispatch: 'pull' } }]) {
    assert.deepEqual(pulled(settings), ITEMS, `${JSON.stringify(settings)} pulls every item`);
    assert.equal(withSettings(settings, jobQueueMode), 'pull');
  }
});

test('clause 1: a malformed pilot is a machine settings refusal [P7]', () => {
  for (const bad of [true, [], { items: 'all' }, { items: [0] }, { items: [1.5] }, { share: 101 }, { share: -1 }, { share: '10' }, { every: true }]) {
    assert.throws(() => withSettings({ gate: { pullPilot: bad } }, loadMachineSettings), /BAD_MACHINE_SETTINGS.*gate\.pullPilot/u, `${JSON.stringify(bad)} is refused`);
  }
});
