/** gate.sampleSwap is off by default, true or false only, described, and read through gateSampleSwap [C7,#10583]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateSampleSwap } from '../../../index.js';
import { loadMachineSettings } from '../../../index.js';
import { describeSetting } from '../../../src/io/settings/descriptions.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../gate/tests/fixtures/testkit.js';

/** Runs read against a private machine home holding the given settings, restoring the home afterwards. */
function readWith(settings, read) {
  const { root: dir } = privateFixtureFiles('pullboard-sample-swap-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    return read();
  } finally { if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved; }
}

test('config.io-settings-sample-swap.clause-1-reads-false-unset: clause 1: gate.sampleSwap reads false when unset, true only when set true, and a non-boolean is refused BAD_MACHINE_SETTINGS [C7,#10583]', () => {
  const read = settings => readWith(settings, () => loadMachineSettings().gate?.sampleSwap === true);
  assert.equal(read({}), false);
  assert.equal(read({ gate: { sampleSwap: false } }), false);
  assert.equal(read({ gate: { sampleSwap: true } }), true);
  assert.throws(() => read({ gate: { sampleSwap: 'yes' } }), error => error.code === 'BAD_MACHINE_SETTINGS' && /gate\.sampleSwap/u.test(error.message));
});

test('config.io-settings-sample-swap.clause-2-described-accessor: clause 2: describeSetting names swap in its description and gateSampleSwap follows the setting [C7,#10583]', () => {
  assert.match(JSON.stringify(describeSetting('gate.sampleSwap')), /swap/u);
  assert.equal(readWith({}, gateSampleSwap), false);
  assert.equal(readWith({ gate: { sampleSwap: true } }, gateSampleSwap), true);
});
