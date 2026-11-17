/** The fixture reader of test.inProcessHooks is off with no setting and on only for an exact true in the fixture machine home [C7,#9214]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';
import { inProcessHooksOn } from '../../fixtures/hook/mode.js';

/** A fresh machine home holding the given settings, or no settings file when `settings` is null. */
function home(settings) {
  const dir = join(privateFixtureFiles('pullboard-hook-mode-').root, 'machine-home');
  mkdirSync(dir, { recursive: true });
  if (settings !== null) fixtureMachineSettings(dir, settings);
  return { PULLBOARD_MACHINE_HOME: dir };
}

test('clause 1: inProcessHooksOn returns false with no setting [C7,#9214]', () => {
  assert.equal(inProcessHooksOn(home(null)), false);
  assert.equal(inProcessHooksOn(home({})), false);
  assert.equal(inProcessHooksOn(home({ test: {} })), false);
  assert.equal(inProcessHooksOn({}), false);
});

test('clause 1: inProcessHooksOn returns true when the fixture machine home holds test.inProcessHooks true [C7,#9214]', () => {
  assert.equal(inProcessHooksOn(home({ test: { inProcessHooks: true } })), true);
  assert.equal(inProcessHooksOn(home({ test: { inProcessHooks: false } })), false);
  assert.equal(inProcessHooksOn(home({ test: { inProcessHooks: 'true' } })), false);
});
