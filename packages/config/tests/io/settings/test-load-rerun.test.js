/** test.loadRerun is a described machine setting, off by default, and only an exact true turns it on [C7,#10597]. @pullboard-test-input source-cell config */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { testLoadRerunEnabled } from '../../../index.js';
import { settingsInventory } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-test-load-rerun-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-test-load-rerun.clause-3-test-loadrerun-is-a-described-setting-off: clause 3: test.loadRerun is a described machine setting, default false, and only an exact true turns it on [C7,#10597]', () => {
  const row = withSettings({}, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(entry => entry.key === 'test.loadRerun'));
  assert.equal(row.default, false);
  assert.equal(row.value, false);
  assert.ok(row.label, 'the row carries a plain label');
  assert.equal(withSettings({}, testLoadRerunEnabled), false);
  assert.equal(withSettings({ test: { loadRerun: true } }, testLoadRerunEnabled), true);
  assert.equal(withSettings({ test: { loadRerun: false } }, testLoadRerunEnabled), false);
});

test('config.io-settings-test-load-rerun.clause-3-a-non-boolean-test-loadrerun-is-refused: clause 3: a non-boolean test.loadRerun is refused with BAD_MACHINE_SETTINGS naming the key [C7,#10597]', () => {
  for (const bad of ['yes', 1, null, 'true']) {
    assert.throws(() => withSettings({ test: { loadRerun: bad } }, testLoadRerunEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /test\.loadRerun/u.test(error.message));
  }
});
