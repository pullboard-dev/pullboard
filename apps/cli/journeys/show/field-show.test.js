/** pullboard show and export print an item's typed fields, behind items.typedFields (#9352, #1321) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { FIXTURE_BRIEF } from '../../tests/fixtures/api.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

/** A fixture repo with one item; `on` sets items.typedFields in the fixture's machine settings. */
async function fixture(t, on) {
  const box = apiHttpFixture(t);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A fixture with no settings file starts empty. */ }
  const run = args => runCliInProcess(args, { cwd: box.root, env: box.env });
  const added = await run(['add', 'app', 'Field item', '--specs', 'G1', '--criterion', 'It holds a field.', '--brief', FIXTURE_BRIEF, '--json']);
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const id = (JSON.parse(added.stdout).result ?? JSON.parse(added.stdout)).item.item_id;
  if (on) {
    writeFileSync(file, JSON.stringify({ ...saved, items: { ...saved.items, typedFields: true } }));
    assert.equal((await run(['field', 'declare', 'priority', 'choice', '--choices', 'low,high'])).status, 0);
    assert.equal((await run(['field', 'declare', 'points', 'number'])).status, 0);
  }
  return { box, id, run, settings: { file, saved } };
}

test('cli.journeys-show-field-show.show-prints-a-fields-block-listing: clause 1: show prints a fields: block listing each set field with its type and value, and omits it when none are set [C7,#9352]', async t => {
  const { id, run } = await fixture(t, true);
  const none = await run(['show', String(id)]);
  assert.equal(none.status, 0, none.stdout + none.stderr);
  assert.doesNotMatch(none.stdout, /^fields:/mu);
  assert.equal((await run(['field', 'set', String(id), 'priority', 'high'])).status, 0);
  assert.equal((await run(['field', 'set', String(id), 'points', '3'])).status, 0);
  const shown = await run(['show', String(id)]);
  assert.match(shown.stdout, /^fields:\n {2}points \(number\): 3\n {2}priority \(choice\): high$/mu);
  const json = JSON.parse((await run(['show', String(id), '--json'])).stdout);
  assert.deepEqual((json.result ?? json).fields, [{ name: 'points', type: 'number', value: 3 }, { name: 'priority', type: 'choice', value: 'high' }]);
});

test('cli.journeys-show-field-show.export-includes-the-item-fields-and: clause 2: export includes the item fields, and with items.typedFields off show and export are byte-identical to before any field was set [C7,#9352]', async t => {
  const { id, run, settings } = await fixture(t, false);
  const plainShow = (await run(['show', String(id)])).stdout;
  const plainExport = (await run(['export'])).stdout;
  assert.doesNotMatch(plainExport, /"fields"/u);
  writeFileSync(settings.file, JSON.stringify({ ...settings.saved, items: { ...settings.saved.items, typedFields: true } }));
  assert.equal((await run(['field', 'declare', 'priority', 'choice', '--choices', 'low,high'])).status, 0);
  assert.equal((await run(['field', 'set', String(id), 'priority', 'high'])).status, 0);
  const on = JSON.parse((await run(['export'])).stdout);
  assert.deepEqual(on.fields, { [id]: [{ name: 'priority', type: 'choice', value: 'high' }] });
  assert.ok(on.tables.item.every(row => !('fields' in row)), 'item rows keep exactly their board columns');
  writeFileSync(settings.file, JSON.stringify({ ...settings.saved, items: { ...settings.saved.items, typedFields: false } }));
  const off = JSON.parse((await run(['export'])).stdout);
  assert.equal(Object.hasOwn(off, 'fields'), false);
  assert.equal((await run(['show', String(id)])).stdout, plainShow);
});
