/** @pullboard-test-input source-cell apps/cli packages/api packages/config */
/** serve gives the gate a timing excuse that follows gate.excuseMainTimingReds [C7,#9756]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { boardHandlerPorts } from '../../../../src/io/commands/serve.js';
import { compareGateWithMain } from '../../../../../../packages/api/index.js';
import { provideTimingExcuse } from '../../../../../../packages/api/index.js';
import { privateFixtureFiles } from '../../../fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../../packages/gate/tests/fixtures/testkit.js';

const MAIN = 'a'.repeat(40);
const FILE = 'apps/cli/tests/io/commands/read-startup.test.js';
const CASE = 'clause 1: reports within 200 ms';

/** A pulled gate's red receipt whose only red is the read-startup case, its message carrying measured milliseconds (no signature). */
const receipt = { gate: { phases: [{ role: 'proof', status: 1, failures: [{ file: FILE, name: CASE }] }] } };

/** Main's receipts answering that main fails the same case under its own name. */
const lookup = ({ cases }) => ({ classes: cases.map(({ file }) => ({ file, owner: 'main', own: [], receipt: null, job: null })) });

/** Whether the comparison reads the case as main's red, with serve's ports provided under the given machine settings. */
async function onMain(settings) {
  const { root: dir } = privateFixtureFiles('pullboard-excuse-main-timing-');
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'machine-home');
  try {
    mkdirSync(process.env.PULLBOARD_MACHINE_HOME, { recursive: true });
    fixtureMachineSettings(process.env.PULLBOARD_MACHINE_HOME, settings);
    await boardHandlerPorts({ isMain: false });
    const compared = compareGateWithMain({ gitRoot: '/repo', db: null }, receipt, MAIN, lookup);
    assert.equal(compared.cases.length, 1);
    return compared.cases[0].onMain;
  } finally {
    provideTimingExcuse(null);
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
  }
}

test('cli.journeys-gate-excuse-main-timing.with-gate-excusemaintimingreds-on-the-only: clause 1: with gate.excuseMainTimingReds on, the only red read-startup case counts as main\'s red [C7,#9756]', async () => {
  assert.equal(await onMain({ gate: { excuseMainTimingReds: true } }), true);
});

test('cli.journeys-gate-excuse-main-timing.with-the-setting-off-or-unset: clause 2: with the setting off, or unset, the same gate stays red [C7,#9756]', async () => {
  assert.equal(await onMain({ gate: { excuseMainTimingReds: false } }), false);
  assert.equal(await onMain({}), false);
});
