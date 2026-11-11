import {
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
/** Every setting in the inventory carries a label, one sentence, a group and a display unit, and the CLI shows them [O5,O6,N26]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { settingsInventory } from '../../../../packages/config/index.js';
import {
  describeSetting,
  SETTING_DESCRIPTIONS,
  CLI_SETTABLE,
} from '../../../../packages/config/index.js';
import { SETTING_FORMS } from '../../index.js';
import { performanceCores } from '../../../../packages/gate/index.js';
import {
  defaultViewPort,
  DEFAULT_VIEW_PORT,
} from '../../../../packages/config/index.js';
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
  const compact = box.run(box.repo, 'settings');
  assert.equal(compact.code, 0, compact.out);
  assert.doesNotMatch(compact.out, /How many test runs/u, 'the default text stays compact');
  const json = JSON.parse(box.run(box.repo, 'settings', '--json').out);
  assert.equal(json.descriptions.gateSlots.label, 'Checks at once', '--json carries the descriptions');
  const out = box.run(box.repo, 'settings', '--detail');
  assert.equal(out.code, 0, out.out);
  const lines = out.out.split('\n');
  for (const key of ['gateSlots', 'browserSlots', 'gate.runnerWaitMs', 'gate.queue.agingMinutes', 'gate.memoryFloorMB', 'view.background', 'gate.runnersOnly', 'workers.budget']) {
    const at = lines.findIndex(line => line.startsWith(key + ':'));
    assert.ok(at >= 0, `${key} is printed`);
    const described = describeSetting(key);
    assert.equal(lines[at + 1], `  ${described.label}: ${described.description} (${described.group}, ${described.unit})`, `${key} is followed by its label and description`);
  }
});

test('the inventory marks exactly the settings the CLI can set, so the view needs no CLI import [O5,O6,N26]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  t.after(() => helpers.cleanup());
  const marked = inventory(box).filter(row => row.cli).map(row => row.key);
  assert.deepEqual([...new Set(marked)].sort(), [...CLI_SETTABLE].sort());
  assert.deepEqual([...CLI_SETTABLE].sort(), SETTING_FORMS.filter(form => !['workers.budget', 'landing.pool'].includes(form)).sort(), 'every CLI form that is an inventory key is marked');
});


test('optional submit handoff is described with default and configured provenance without adding a raw default [O5,O6,V4]', t => {
  const helpers = createE2eHelpers();
  const box = helpers.project('true');
  t.after(() => helpers.cleanup());
  const file = join(box.repo, 'pullboard.json');
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(raw.submit?.handoff, undefined, 'existing default configuration bytes acquire no new submit key');
  const row = () => inventory(box).find(setting => setting.scope === 'repo' && setting.key === 'submit.handoff');
  assert.equal(row().value, false);
  assert.equal(row().default, false);
  assert.equal(row().origin, 'default');
  assert.equal(row().cli, null, 'repository JSON configuration is not falsely offered as a machine settings CLI form');
  assert.equal(row().label, 'Return while checks run');
  writeFileSync(file, JSON.stringify({ ...raw, submit: { ...raw.submit, handoff: true } }) + '\n');
  assert.equal(row().value, true);
  assert.equal(row().origin, 'configured');
  writeFileSync(file, JSON.stringify({ ...raw, submit: { ...raw.submit, handoff: false } }) + '\n');
  assert.equal(row().value, false);
  assert.equal(row().origin, 'configured');
});
