/** Every setting in the inventory carries a label, one sentence, a group and a display unit, and the CLI shows them [O5,O6,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsInventory } from '../src/settings-inventory.js';
import { describeSetting, SETTING_DESCRIPTIONS } from '../src/settings-descriptions.js';
import { performanceCores } from '../src/gate.js';
import {
  defaultViewPort,
  DEFAULT_VIEW_PORT,
} from '../src/config.js';
import { createE2eHelpers } from './e2e-helpers.js';

/** Read the production inventory in the fixture's own machine home, restoring the caller's environment. */
function inventory(box) {
  const previous = Object.fromEntries(['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME'].map(key => [key, process.env[key]]));
  try {
    for (const key of Object.keys(previous)) process.env[key] = box.env[key];
    return settingsInventory([{ root: box.repo }], null, { performanceCores, defaultViewPort, DEFAULT_VIEW_PORT }).settings;
  } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

const words = value => typeof value === 'string' && value.trim() === value && value.length > 0;

test('every inventory key carries a label, one sentence, a group and a display unit [O5,O6,N26]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  t.after(() => helpers.cleanup());
  const rows = inventory(box);
  assert.ok(rows.length > 100, 'the inventory is the whole supported set, not a sample');
  assert.deepEqual(['board', 'machine', 'repo'], [...new Set(rows.map(row => row.scope))].sort(), 'every scope is covered');
  for (const row of rows) {
    for (const field of ['label', 'description', 'group', 'unit']) assert.ok(words(row[field]), `${row.scope} ${row.key} needs a ${field}`);
    assert.match(row.description, /[.]$/u, `${row.key} description is a sentence`);
    assert.equal(row.description.split(/[.] /u).length, 1, `${row.key} description is one sentence`);
  }
  assert.deepEqual(rows.filter(row => row.scope === 'machine').map(row => row.group).filter((group, index, all) => all.indexOf(group) === index).filter(group => ['Capacity', 'Order', 'Runners', 'Background'].includes(group)).sort(),
    ['Background', 'Capacity', 'Order', 'Runners'], 'machine settings use the four approved groups');
  const repoGroups = new Set(rows.filter(row => row.scope !== 'machine').map(row => row.group));
  for (const group of ['Landing', 'Checks', 'Relay']) assert.ok(repoGroups.has(group), `${group} group exists on repo or board settings`);
  assert.equal(rows.find(row => row.key === 'gate.memoryFloorMB').unit, 'MB');
  assert.equal(rows.find(row => row.key === 'gate.runnersFirst').unit, 'on/off');
  assert.equal(rows.find(row => row.key === 'gate.queue.agingMinutes').unit, 'minutes');
});

test('a described key that no setting reads is a stale description [O5,O6,N26]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  t.after(() => helpers.cleanup());
  const keys = new Set(inventory(box).map(row => row.key));
  const printedOnly = new Set(['workers.budget']);
  for (const key of Object.keys(SETTING_DESCRIPTIONS)) assert.ok(keys.has(key) || printedOnly.has(key), `${key} is described but is in no inventory`);
});

test('named resources are described from their name and unknown keys are not invented [O5,O6]', () => {
  assert.match(describeSetting('resources.browser.capacity').description, /browser/u);
  assert.equal(describeSetting('resources.browser.capacity').unit, 'count');
  assert.equal(describeSetting('no.such.setting'), null);
});

test('pullboard settings prints each label and description beside its key [O5,O6,N26]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  t.after(() => helpers.cleanup());
  const out = box.run(box.repo, 'settings');
  assert.equal(out.code, 0, out.out);
  const lines = out.out.split('\n');
  for (const key of ['gateSlots', 'browserSlots', 'gate.runnerWaitMs', 'gate.queue.agingMinutes', 'gate.memoryFloorMB', 'view.background', 'gate.runnersOnly', 'workers.budget']) {
    const at = lines.findIndex(line => line.startsWith(key + ':'));
    assert.ok(at >= 0, `${key} is printed`);
    const described = describeSetting(key);
    assert.equal(lines[at + 1], `  ${described.label}: ${described.description} (${described.group}, ${described.unit})`, `${key} is followed by its label and description`);
  }
});
