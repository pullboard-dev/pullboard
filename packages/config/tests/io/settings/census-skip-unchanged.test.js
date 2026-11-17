/** census.skipUnchanged is a machine setting, off by default, rejecting values that are not true or false [C7,#10381]. @pullboard-test-input source-cell config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { censusSkipUnchangedEnabled } from '../../../index.js';
import { settingsInventory } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-skip-unchanged-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-census-skip-unchanged.clause-1-census-skipunchanged-exists-off-by: clause 1: census.skipUnchanged exists as a described setting, is off by default and rejects non-boolean values [C7,#10381]', () => {
  const row = withSettings({}, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'census.skipUnchanged'));
  assert.equal(row.default, false);
  assert.equal(row.value, false);
  assert.ok(row.label);
  assert.equal(withSettings({}, censusSkipUnchangedEnabled), false);
  assert.equal(withSettings({ census: { skipUnchanged: true } }, censusSkipUnchangedEnabled), true);
  assert.throws(() => withSettings({ census: { skipUnchanged: 'yes' } }, censusSkipUnchangedEnabled), /census\.skipUnchanged/u);
});
