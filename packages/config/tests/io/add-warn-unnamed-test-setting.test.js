/** add.warnUnnamedTest is a machine setting, off by default, described, and on only for an exact true [C7,#9303]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { addWarnUnnamedTest } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-add-warn-unnamed-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 1: add.warnUnnamedTest is a described setting, off by default, on only for an exact true [C7,#9303]', () => {
  const row = withSettings({}, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'add.warnUnnamedTest'));
  assert.equal(row.default, false);
  assert.equal(row.value, false);
  assert.ok(row.label, 'the row carries a plain label');
  assert.equal(withSettings({}, addWarnUnnamedTest), false);
  assert.equal(withSettings({ add: { warnUnnamedTest: true } }, addWarnUnnamedTest), true);
  assert.throws(() => withSettings({ add: { warnUnnamedTest: 'yes' } }, addWarnUnnamedTest), /add\.warnUnnamedTest/u);
});
