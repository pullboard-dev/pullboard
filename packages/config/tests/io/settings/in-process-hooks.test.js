/** test.inProcessHooks is a described machine setting, off by default, true or false only [C7,#9210]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../index.js';
import { describeSetting } from '../../../src/io/settings/descriptions.js';
import { settingsInventory } from '../../../src/io/settings/inventory.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Loads the machine settings from a private machine home holding the given settings, restoring the home afterwards. */
function loadWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-in-process-hooks-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return loadMachineSettings();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-in-process-hooks.clause-1-test-inprocesshooks-is: clause 1: test.inProcessHooks is described and defaults to false [C7,#9210]', () => {
  const row = settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'test.inProcessHooks');
  assert.equal(row.value, false);
  assert.match(JSON.stringify(describeSetting('test.inProcessHooks')), /in-process/u);
});

test('config.io-settings-in-process-hooks.clause-1-test-inprocesshooks-accepts: clause 1: test.inProcessHooks accepts true and false [C7,#9210]', () => {
  assert.equal(loadWith({ test: { inProcessHooks: true } }).test.inProcessHooks, true);
  assert.equal(loadWith({ test: { inProcessHooks: false } }).test.inProcessHooks, false);
});

test('config.io-settings-in-process-hooks.clause-1-any-other-test-inprocesshooks: clause 1: any other test.inProcessHooks value is refused BAD_MACHINE_SETTINGS [C7,#9210]', () => {
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => loadWith({ test: { inProcessHooks: bad } }), (error) => error.code === 'BAD_MACHINE_SETTINGS' && /test\.inProcessHooks/u.test(error.message));
  }
});
