/** @pullboard-test-loads packages/gate/src/io/test/tier/selection.js */
/** Tier selection keeps every test for a global change, runs a new tooling test at submit, ignores a project without a path map, and runs the canary at every gate [C7,#4015,#10874]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeTestTiers } from '../../../../heavy.js';
import { toolingTests } from '../../../../src/io/test/tier/selection.js';
import { DEFAULT_CANARY } from '../../../../src/io/test/tier/selection.js';
import { submitGatePlan } from '../../../../heavy.js';
import { fixture as repository } from '../../../../../landing/tests/fixtures/plan.js';
import { git } from '../../../../../landing/tests/fixtures/plan.js';
import { frozen } from './frozen.js';
import { change } from './frozen.js';
import { OTHER_TEST } from './frozen.js';
import { SIZE_TEST } from './frozen.js';
import { WEB_TEST } from './frozen.js';

test('gate.io-test-tier-selection.a-global-change-keeps-the-tooling: a global change keeps the tooling tier with every other test [C7,#4015]', t => {
  const plan = change(frozen(t), { 'package.json': '{"type":"module","private":true}\n' });
  for (const file of [SIZE_TEST, OTHER_TEST, WEB_TEST]) assert.ok(plan.units.includes(file), `${file} runs: ${plan.units}`);
});

test('gate.io-test-tier-selection.a-tooling-test-the-change-itself: a tooling test the change itself adds runs at submit though no former bin file changed [C7,#4015]', t => {
  const added = 'packages/gate/tests/io/size-new.test.js';
  const plan = change(frozen(t), { [added]: "import { size } from '../../src/io/size.js';\nvoid size;\n" });
  assert.ok(plan.units.includes(added), `the builder's own new test runs: ${plan.units}`);
  assert.ok(!plan.units.includes(SIZE_TEST), 'the unchanged tooling test stays out');
});

test('gate.io-test-tier-selection.a-project-without-a-layout-path: a project without a layout path map has no tooling tier and selects as before [C7,#4015]', t => {
  const { root, put } = repository(t);
  put('packages/gate/src/io/size.js', 'export const size = 1;\n');
  put(SIZE_TEST, "import { size } from '../../src/io/size.js';\nvoid size;\n");
  writeTestTiers(root);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const plan = change({ root, put, base: git(root, 'rev-parse', 'HEAD').trim() }, { 'packages/gate/src/io/size.js': 'export const size = 2;\n' });
  assert.deepEqual(toolingTests(root, 'HEAD'), []);
  assert.ok(plan.units.includes(SIZE_TEST));
});

/** Commit the default canary files (each reaching nothing a change touches) as a new base, with pullboard.json when one is given. */
function withCanary(box, config) {
  for (const file of DEFAULT_CANARY) box.put(file, "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  if (config) box.put('pullboard.json', JSON.stringify(config));
  git(box.root, 'add', '-A');
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'canary');
  return { ...box, base: git(box.root, 'rev-parse', 'HEAD').trim() };
}

test('gate.io-test-tier-selection.a-change-that-reaches-no-canary: clause 1: a change that reaches no canary file still runs the closure budget and stable-ID files at every gate when pullboard.json declares no canary [C7,#10874]', t => {
  const off = change(withCanary(frozen(t), { canary: [] }), { 'packages/web/src/page.js': 'export const page = 2;\n' });
  for (const file of DEFAULT_CANARY) assert.ok(!off.units.includes(file), `the change itself reaches no canary file: ${off.units}`);
  const plan = change(withCanary(frozen(t)), { 'packages/web/src/page.js': 'export const page = 2;\n' });
  for (const file of DEFAULT_CANARY) assert.ok(plan.units.includes(file), `${file} runs: ${plan.units}`);
  for (const file of DEFAULT_CANARY) assert.ok(!plan.journeys.includes(file), `${file} is not left to the batch alone`);
});

test('gate.io-test-tier-selection.a-declared-canary-list-replaces-the: clause 2: a pullboard.json canary list replaces the default, and a listed file the tree lacks is skipped, never refused [C7,#10874]', t => {
  const [budget, stable] = DEFAULT_CANARY;
  const plan = change(withCanary(frozen(t), { canary: [stable, 'packages/gate/tests/io/gone.test.js'] }), { 'packages/web/src/page.js': 'export const page = 2;\n' });
  assert.ok(plan.units.includes(stable), `the declared canary runs: ${plan.units}`);
  assert.ok(!plan.units.includes(budget), 'a default file the list leaves out does not run');
  assert.ok(!plan.units.includes('packages/gate/tests/io/gone.test.js'), 'a listed file the tree lacks is skipped');
});

test('gate.io-test-tier-selection.a-project-with-no-tier: clause 3: a project with no tier manifest gets the canary in the submit gate proof on every submit, deferred or not [C7,#10874]', t => {
  const { root, put } = repository(t);
  for (const file of DEFAULT_CANARY) put(file, "import assert from 'node:assert/strict';\nassert.ok(true);\n");
  put('test/stats.test.js', "import { stats } from '../src/stats.js';\nvoid stats;\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  put('src/stats.js', "export const stats = () => 2;\n");
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'change');
  const commit = git(root, 'rev-parse', 'HEAD').trim();
  for (const submitGate of [undefined, 'landing']) {
    const plan = submitGatePlan(root, { gate: 'true', affectedTests: 'node --test', submitInvariants: [], registryGuards: [], ...(submitGate ? { submitGate } : {}) }, { base, commit });
    assert.equal(plan.testTiers, null, 'the project has no tier manifest');
    for (const file of DEFAULT_CANARY) assert.ok(plan.proofFiles.includes(file), `${submitGate ?? 'immediate'} submit runs ${file}: ${plan.proofFiles}`);
  }
});
