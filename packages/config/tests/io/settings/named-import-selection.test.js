/** gate.namedImportSelection is off by default, true or false only, and described [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { namedImportSelectionOn } from '../../../index.js';
import { describeSetting } from '../../../src/io/settings/descriptions.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Reads gate.namedImportSelection for a private machine home holding the given settings, restoring the home afterwards. */
function readWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-named-import-selection-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return namedImportSelectionOn();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 3: gate.namedImportSelection is a described setting, off by default [C7]', () => {
  assert.equal(readWith({}), false);
  assert.equal(readWith({ gate: { namedImportSelection: false } }), false);
  assert.equal(readWith({ gate: { namedImportSelection: true } }), true);
  assert.throws(() => readWith({ gate: { namedImportSelection: 'yes' } }), /gate\.namedImportSelection/u);
  assert.match(describeSetting('gate.namedImportSelection').description, /re-exporting door/u);
});
