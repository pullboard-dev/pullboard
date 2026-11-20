/** list.thinRead is a machine setting, on by default, described, and off only for an exact false [C7,#9089,#9072]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { listThinRead } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-list-thin-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for list.thinRead. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'list.thinRead'));
}

test('config.io-list-thin-read-setting.clause-3-list-thinread-is-on-by-default: clause 3: list.thinRead is on by default, off only for an exact false, and a non-boolean is refused [C7,#9089,#9072]', () => {
  const unset = row({});
  assert.equal(unset.default, true);
  assert.equal(unset.value, true);
  assert.equal(withSettings({}, listThinRead), true);
  assert.equal(withSettings({ list: { thinRead: false } }, listThinRead), false);
  assert.throws(() => withSettings({ list: { thinRead: 'yes' } }, listThinRead), /list\.thinRead/u);
});

test('config.io-list-thin-read-setting.clause-3-list-thinread-is-a-described: clause 3: list.thinRead is a described setting that pullboard settings prints [C7,#9089]', () => {
  const described = row({});
  assert.ok(described.label, 'the row carries a plain label');
  assert.match(described.description ?? JSON.stringify(described), /thin read door/u);
});
