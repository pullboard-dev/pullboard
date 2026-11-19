/** board.crossProcessWrites is a machine setting, off by default, described, and on only for an exact true [C7,#9814]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { readCrossProcessWrites } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-board-cpw-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for board.crossProcessWrites. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'board.crossProcessWrites'));
}

test('config.io-board-cross-process-writes-setting.clause-1-board-crossprocesswrites: clause 1: board.crossProcessWrites defaults to false, is listed with a description, and readCrossProcessWrites() is true only on an exact true [C7,#9814]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /shared by every process|file queue/u);
  assert.equal(withSettings({}, readCrossProcessWrites), false);
  assert.equal(withSettings({ board: { crossProcessWrites: true } }, readCrossProcessWrites), true);
  assert.equal(withSettings({ board: { crossProcessWrites: false } }, readCrossProcessWrites), false);
});

test('config.io-board-cross-process-writes-setting.clause-2-a-non-boolean-board: clause 2: a non-boolean board.crossProcessWrites refuses with BAD_MACHINE_SETTINGS [C7,#9814]', () => {
  for (const bad of ['yes', 1, 'true', null]) {
    assert.throws(() => withSettings({ board: { crossProcessWrites: bad } }, readCrossProcessWrites), error => error.code === 'BAD_MACHINE_SETTINGS' && /board\.crossProcessWrites/u.test(error.message));
  }
});
