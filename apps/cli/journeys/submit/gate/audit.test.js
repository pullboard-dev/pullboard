/** The submit gate leaves landing.auditOnly test files to the main audit unless the item changes them [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectTestTiers } from '../../../../../packages/gate/index.js';
import { submitGatePlan } from '../../../../../packages/gate/index.js';
import { testTierReport } from '../../../../../packages/gate/index.js';
import { writeTestTiers } from '../../../../../packages/gate/index.js';
import { git } from '../../../../../packages/landing/tests/fixtures/plan.js';
import { frozen } from '../../../../../packages/gate/tests/io/test/tier/frozen.js';
import { SIZE_TEST } from '../../../../../packages/gate/tests/io/test/tier/frozen.js';
import { OTHER_TEST } from '../../../../../packages/gate/tests/io/test/tier/frozen.js';
import { MIXED_TEST } from '../../../../../packages/gate/tests/io/test/tier/frozen.js';

/** Commit `files` on the frozen fixture and return the commit. */
function commitChange(box, files) {
  for (const [file, source] of Object.entries(files)) box.put(file, source);
  writeTestTiers(box.root);
  git(box.root, 'add', '-A');
  git(box.root, 'commit', '-q', '-m', 'change');
  return git(box.root, 'rev-parse', 'HEAD').trim();
}

test('auditOnly file left to audit unless changed [C7]', t => {
  const box = frozen(t);
  const commit = commitChange(box, { 'packages/gate/src/io/size.js': 'export const size = 2;\n' });
  const without = selectTestTiers(box.root, { base: box.base, commit });
  assert.ok(without.units.includes(SIZE_TEST) && without.units.includes(OTHER_TEST), 'with no auditOnly every unit of the package runs');
  assert.equal(without.auditLeft, undefined);

  const auditOnly = [SIZE_TEST, 'docs/not-selected.test.js'];
  const plan = selectTestTiers(box.root, { base: box.base, commit, auditOnly });
  assert.ok(!plan.units.includes(SIZE_TEST), 'the listed file leaves the gate');
  assert.deepEqual(plan.auditLeft, [SIZE_TEST], 'only a listed file that would have run is named');
  assert.deepEqual(plan.units, without.units.filter(file => file !== SIZE_TEST));
  assert.match(testTierReport(plan), /Left to the main audit \(landing\.auditOnly\) \(1\): packages\/gate\/tests\/io\/size\.test\.js/u);

  const composed = submitGatePlan(box.root, { gate: 'node --test', affectedTests: 'node --test', landing: { auditOnly } }, { base: box.base, commit });
  assert.ok(!composed.proofFiles.includes(SIZE_TEST), 'the submit proof run drops the listed file');
  assert.ok(composed.proofFiles.includes(OTHER_TEST));
  assert.deepEqual(composed.testTiers.auditLeft, [SIZE_TEST]);
});

test('an auditOnly file the item changes still runs in its gate [C7]', t => {
  const box = frozen(t);
  const commit = commitChange(box, { 'packages/gate/src/io/size.js': 'export const size = 2;\n', [SIZE_TEST]: "import { size } from '../../src/io/size.js';\nvoid [size, 1];\n" });
  const plan = selectTestTiers(box.root, { base: box.base, commit, auditOnly: [SIZE_TEST, MIXED_TEST] });
  assert.ok(plan.units.includes(SIZE_TEST), 'a changed listed file runs');
  assert.deepEqual(plan.auditLeft, [MIXED_TEST], 'only the untouched listed file is left');
  assert.ok(!plan.units.includes(MIXED_TEST));
});
