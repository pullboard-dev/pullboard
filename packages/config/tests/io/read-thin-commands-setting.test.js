/** read.thinCommands is a machine setting, off by default, described, and on only for an exact true [C7,#9810]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readThinCommands } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-read-thin-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for read.thinCommands. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'read.thinCommands'));
}

test('config.io-read-thin-commands-setting.clause-1-read-thincommands-defaults-to: clause 1: read.thinCommands defaults to false, is listed with a description, and readThinCommands() is true only on an exact true [C7,#9810]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /thin read doors/u);
  assert.equal(withSettings({}, readThinCommands), false);
  assert.equal(withSettings({ read: { thinCommands: true } }, readThinCommands), true);
  assert.equal(withSettings({ read: { thinCommands: false } }, readThinCommands), false);
});

test('config.io-read-thin-commands-setting.clause-2-a-non-boolean-read-thincommands: clause 2: a non-boolean read.thinCommands refuses with BAD_MACHINE_SETTINGS [C7,#9810]', () => {
  for (const bad of ['yes', 1, 'true', null]) {
    assert.throws(() => withSettings({ read: { thinCommands: bad } }, readThinCommands), error => error.code === 'BAD_MACHINE_SETTINGS' && /read\.thinCommands/u.test(error.message));
  }
});
