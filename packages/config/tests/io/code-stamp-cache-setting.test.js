/** api.codeStampCache is a machine setting, off by default, listed with a description [C7,#9679]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { codeStampCacheEnabled } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-code-stamp-cache-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-code-stamp-cache-setting.api-codestampcache-is-a-described: api.codeStampCache is a described setting, off by default, on only for an exact true [C7,#9679]', () => {
  const unset = withSettings({}, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'api.codeStampCache'));
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.equal(withSettings({}, codeStampCacheEnabled), false);
  assert.equal(withSettings({ api: { codeStampCache: true } }, codeStampCacheEnabled), true);
  assert.throws(() => withSettings({ api: { codeStampCache: 'yes' } }, codeStampCacheEnabled), /api\.codeStampCache/u);
});
