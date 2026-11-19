/** @pullboard-test-input source-cell packages/gate */
/** The submit gate admission maps an item's declared needs onto the browser and GUI slots [C7,#1888]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { submitGateAdmission } from '../../src/io/submit.js';
import { privateFixtureFiles } from '../fixtures/child.js';

test('gate.io-submit.admission-item-needs: clause 1: submitGateAdmission returns browser true for options.needs [browser] and gui true for [gui] even when no check or proof file asks, and returns exactly the current admission when needs is absent or empty [C7]', async t => {
  const { root } = privateFixtureFiles('pullboard-admission-needs-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  writeFileSync(join(root, 'test', 'plain.test.js'), "import { test } from 'node:test';\ntest('plain', () => {});\n");
  const files = ['test/plain.test.js'];
  const plan = { check: '', selection: { full: false, files }, deferFullFallback: false, deferSelection: false, proofFiles: files };
  const options = { allowBrowserFreeChecks: true };
  const current = await submitGateAdmission(root, plan, options);
  assert.deepEqual(current, { browser: false, gui: false }, 'nothing asks, so no slot is requested');
  assert.deepEqual(await submitGateAdmission(root, plan, { ...options, needs: [] }), current, 'an empty needs list changes nothing');
  assert.deepEqual(await submitGateAdmission(root, plan, { ...options, needs: ['browser'] }), { browser: true, gui: false }, 'a browser need asks for the browser slot');
  assert.deepEqual(await submitGateAdmission(root, plan, { ...options, needs: ['gui'] }), { browser: false, gui: true }, 'a gui need asks for the GUI slot');
  assert.deepEqual(await submitGateAdmission(root, plan, { ...options, needs: ['browser', 'gui'] }), { browser: true, gui: true }, 'both needs ask for both slots');
});
