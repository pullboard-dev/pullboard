/** gate.sampleDiskIo is off by default, true or false only, and described [C7,#9029]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadMachineSettings } from '../../../index.js';
import { describeSetting } from '../../../src/io/settings/descriptions.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Loads the machine settings for a private machine home holding the given settings, restoring the home afterwards. */
function readWith(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-sample-disk-io-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return loadMachineSettings().gate?.sampleDiskIo === true;
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('clause 2: gate.sampleDiskIo is off when unset and on only when set true [C7,#9029]', () => {
  assert.equal(readWith({}), false);
  assert.equal(readWith({ gate: { sampleDiskIo: false } }), false);
  assert.equal(readWith({ gate: { sampleDiskIo: true } }), true);
});

test('clause 2: a non-boolean gate.sampleDiskIo is refused naming the setting, and the setting is described [C7,#9029]', () => {
  assert.throws(() => readWith({ gate: { sampleDiskIo: 'yes' } }), /gate\.sampleDiskIo/u);
  assert.match(JSON.stringify(describeSetting('gate.sampleDiskIo')), /disk busy/u);
});
