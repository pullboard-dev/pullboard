/** The modelTiers setting is described, so the settings API row the view renders carries its label [O5,O6,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  describeSetting,
  settingsInventory,
} from '../../../../packages/config/index.js';
import { SETTING_DESCRIPTIONS } from '../../../../packages/config/index.js';
import {
  defaultViewPort,
  DEFAULT_VIEW_PORT,
} from '../../../../packages/config/index.js';
import { performanceCores } from '../../../../packages/gate/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';

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

test('clause 1: the description list has a modelTiers row and the settings API row for modelTiers carries it [O5,O6,N26]', t => {
  const described = SETTING_DESCRIPTIONS.modelTiers;
  assert.ok(described, 'the description list has a modelTiers row');
  for (const field of ['label', 'description', 'group', 'unit']) assert.ok(typeof described[field] === 'string' && described[field].trim(), `modelTiers has a ${field}`);
  assert.deepEqual(describeSetting('modelTiers'), described);
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  t.after(() => helpers.cleanup());
  const row = inventory(box).find(entry => entry.key === 'modelTiers');
  assert.ok(row, 'the settings inventory serves a modelTiers row');
  assert.deepEqual([row.label, row.description, row.group, row.unit], [described.label, described.description, described.group, described.unit],
    'the served row carries the described label, sentence, group and unit');
});
