/** The Settings inventory reads gate.timingRunner false as off and puts a wrong-typed setting on its own row [O5,O6,N26]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { settingsInventory } from '../../../../packages/config/index.js';
import { machineSettingsFile } from '../../../../packages/config/index.js';
import { defaultViewPort } from '../../../../packages/config/index.js';
import { DEFAULT_VIEW_PORT } from '../../../../packages/config/index.js';
import { performanceCores } from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

/** Read the production inventory in the fixture's own machine home, restoring the caller's environment. */
function inventory(box, gate) {
  const previous = Object.fromEntries(['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(previous)) process.env[key] = box.env[key];
    writeFileSync(machineSettingsFile(), JSON.stringify({ gate }));
    return settingsInventory([{ root: box.repo }], null, { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT }).settings;
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

test('the inventory reads gate.timingRunner false as a valid off setting with no error [O5,O6,N26]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  t.after(() => helpers.cleanup());
  const row = inventory(box, { timingRunner: false }).find(entry => entry.scope === 'machine' && entry.key === 'gate.timingRunner');
  assert.equal(row.value, false);
  assert.equal(row.error, undefined);
  assert.equal(row.origin, 'configured');
});

test('a wrong-typed setting is an error on its own row that names the setting [O5,O6,N26]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  t.after(() => helpers.cleanup());
  const bad = inventory(box, { runnersOnly: 'yes' }).find(row => row.scope === 'machine' && row.key === 'gate.runnersOnly');
  assert.ok(bad.error, 'the wrong-typed setting carries its own problem');
  assert.equal(bad.value, null);
  assert.match(bad.error.message, /gate\.runnersOnly/u);
  assert.match(bad.error.fix, /Set gate\.runnersOnly back to false or remove it from /u);
  assert.doesNotMatch(JSON.stringify(bad.error), /BAD_SETTINGS|unsupported type/u);
});

test('every other setting is still listed when one setting is wrong-typed [O5,O6,N26]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  t.after(() => helpers.cleanup());
  const healthy = inventory(box, {}).filter(row => row.scope === 'machine');
  const rows = inventory(box, { runnersOnly: 'yes' }).filter(row => row.scope === 'machine');
  assert.deepEqual(rows.map(row => row.key), healthy.map(row => row.key), 'no other setting disappears');
  assert.ok(rows.filter(row => row.key !== 'gate.runnersOnly').every(row => !row.error), 'no other row is marked bad');
});
