/** With gate.staticLoadAdmission on, local static slots drop to one under heavy load and return below it [C7,#8735]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { rmSync } from 'node:fs';
import { staticCheckSlots } from '../../../../../packages/config/index.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { fixtureMachineSettings } from '../../fixtures/testkit.js';

/** Point machine storage at a fresh folder holding the given settings for one test; returns the restore. */
function isolatedMachine(settings) {
  const home = privateFixtureFiles('pullboard-static-load-').root;
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  fixtureMachineSettings(home, settings);
  return () => {
    if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before;
    rmSync(home, { recursive: true, force: true });
  };
}

test('cli.io-static-load-admission.with-gate-staticloadadmission-on-slots-drop-to: clause 1: with gate.staticLoadAdmission on, slots drop to 1 above twice the core count and return to gate.staticSlots below it [C7,#8735]', () => {
  const restore = isolatedMachine({ gate: { staticSlots: 3, staticLoadAdmission: true } });
  try {
    assert.equal(staticCheckSlots({ load: 17, cores: 8 }), 1, 'load 17 is above 16');
    assert.equal(staticCheckSlots({ load: 16, cores: 8 }), 3, 'load at exactly twice the cores is not above it');
    assert.equal(staticCheckSlots({ load: 4, cores: 8 }), 3);
  } finally { restore(); }
});

test('cli.io-static-load-admission.with-gate-staticloadadmission-off-heavy-load-leaves: clause 1: with gate.staticLoadAdmission off, heavy load leaves the slots at gate.staticSlots [C7,#8735]', () => {
  const restore = isolatedMachine({ gate: { staticSlots: 3 } });
  try { assert.equal(staticCheckSlots({ load: 100, cores: 8 }), 3); } finally { restore(); }
});
