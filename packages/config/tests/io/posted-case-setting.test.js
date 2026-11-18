/** runners.postedLineNamesCase is a described machine setting, off by default, stored flat beside the runners list (#9084) [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** The settings row for runners.postedLineNamesCase, read through the real inventory with the given machine settings. */
function row(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-posted-case-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'runners.postedLineNamesCase');
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-posted-case-setting.clause-3-runners-postedlinenamescase-is: clause 3: runners.postedLineNamesCase is a described setting, off by default, and on only for an exact true stored flat (#9084) [C7]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label && unset.description, 'the row carries a label and a description');
  assert.match(unset.description, /first failing case/u);
  assert.equal(row({ runners: [], 'runners.postedLineNamesCase': true }).value, true);
  assert.throws(() => row({ 'runners.postedLineNamesCase': 'yes' }), /runners\.postedLineNamesCase/u);
});
