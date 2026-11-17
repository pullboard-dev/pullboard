/** submit.recoverFromJobRow is a machine setting, off by default, listed with a description [C7,#9824]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { recoverFromJobRow } from '../../index.js';
import { settingsInventory } from '../../index.js';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../gate/tests/fixtures/testkit.js';

/** Run `read` against a private machine home holding the given settings, restoring the home afterwards. */
function withSettings(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-submit-recover-from-job-row-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

/** The settings row pullboard settings prints for submit.recoverFromJobRow. */
function row(settings) {
  return withSettings(settings, () => settingsInventory([], null, { defaultViewPort: () => 0, DEFAULT_VIEW_PORT: 0 }).settings.find(r => r.key === 'submit.recoverFromJobRow'));
}

test('clause 1: submit.recoverFromJobRow is a described machine setting, off by default [C7,#9824]', () => {
  const unset = row({});
  assert.equal(unset.default, false);
  assert.equal(unset.value, false);
  assert.equal(unset.origin, 'default');
  assert.ok(unset.label, 'the row carries a plain label');
  assert.match(unset.description ?? JSON.stringify(unset), /job row/u);
});

test('clause 2: recoverFromJobRow() is true only for an exact true [C7,#9824]', () => {
  assert.equal(withSettings({}, recoverFromJobRow), false);
  assert.equal(withSettings({ submit: { recoverFromJobRow: false } }, recoverFromJobRow), false);
  assert.equal(withSettings({ submit: { recoverFromJobRow: true } }, recoverFromJobRow), true);
});

test('clause 3: a non-boolean submit.recoverFromJobRow is refused BAD_MACHINE_SETTINGS [C7,#9824]', () => {
  for (const bad of ['yes', 1, 'true']) {
    assert.throws(() => withSettings({ submit: { recoverFromJobRow: bad } }, recoverFromJobRow), (err) => err.code === 'BAD_MACHINE_SETTINGS' && /submit\.recoverFromJobRow/u.test(err.message));
  }
});
