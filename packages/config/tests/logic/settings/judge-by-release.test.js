/** @pullboard-test-input source-cell config */
/** moves.judgeByRelease is a machine setting, off by default, validated as a boolean and described [C7,U150]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { judgeByReleaseEnabled } from '../../../index.js';
import { loadMachineSettings } from '../../../index.js';
import { settingsInventory } from '../../../index.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-judge-by-release-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for moves.judgeByRelease, read through the real inventory. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'moves.judgeByRelease'));
}

test('config.logic-settings-judge-by-release.clause-1-moves-judgebyrelease-is-false-on-an: clause 1: moves.judgeByRelease reads false on an empty machine config and true when set true [C7,U150]', () => {
  assert.equal(withSettings({}, () => loadMachineSettings().moves?.judgeByRelease === true), false);
  assert.equal(withSettings({}, judgeByReleaseEnabled), false);
  assert.equal(row({}).default, false);
  assert.equal(row({}).value, false);
  assert.equal(withSettings({ moves: { judgeByRelease: true } }, () => loadMachineSettings().moves.judgeByRelease), true);
  assert.equal(withSettings({ moves: { judgeByRelease: true } }, judgeByReleaseEnabled), true);
  assert.equal(withSettings({ moves: { judgeByRelease: false } }, judgeByReleaseEnabled), false);
});

test('config.logic-settings-judge-by-release.clause-2-a-non-boolean-moves-judgebyrelease: clause 2: a non-boolean moves.judgeByRelease is refused with BAD_MACHINE_SETTINGS [C7,U150]', () => {
  for (const bad of ['yes', 1, null]) {
    assert.throws(() => withSettings({ moves: { judgeByRelease: bad } }, judgeByReleaseEnabled), error => error.code === 'BAD_MACHINE_SETTINGS' && /moves\.judgeByRelease/u.test(error.message));
  }
});

test('config.logic-settings-judge-by-release.clause-3-judgebyrelease-has-a-description-row: clause 3: judgeByRelease has a description row that pullboard settings prints [C7,U150]', () => {
  const described = row({});
  assert.equal(described.label, 'Judge by the last release');
  assert.match(described.description, /last release tag/u);
});
