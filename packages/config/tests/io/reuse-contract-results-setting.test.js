/** landing.reuseContractResults is a machine setting, off by default, listed with a description [C7,#9301]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { reuseContractResultsEnabled } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-reuse-contract-results-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for landing.reuseContractResults. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'landing.reuseContractResults'));
}

test('config.io-reuse-contract-results-setting.clause-1-landing-reusecontractresults-is: clause 1: landing.reuseContractResults is a described setting, off by default, on only for an exact true [C7,#9301]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /contract/u);
  assert.equal(withSettings({}, reuseContractResultsEnabled), false);
  assert.equal(withSettings({ landing: { reuseContractResults: true } }, reuseContractResultsEnabled), true);
  assert.throws(() => withSettings({ landing: { reuseContractResults: 'yes' } }, reuseContractResultsEnabled), /landing\.reuseContractResults/u);
});
