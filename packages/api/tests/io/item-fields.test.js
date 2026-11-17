/** @pullboard-test-input source-cell apps/cli packages/api packages/store pages kernel */
/** The item API sends an item's typed fields and related links when items.typedFields is on, and leaves both out when it is off (#9835, #1321) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpBox } from '../../../../apps/cli/tests/fixtures/api.js';
import { FIXTURE_BRIEF } from '../../../../apps/cli/tests/fixtures/api.js';
import { withFixtureBoard } from '../../../../apps/cli/tests/fixtures/board.js';
import { relateItems } from '../../../store/index.js';

/** A served board with two items, a number field set on the first, and the two items related. */
async function fixture(t) {
  const box = await apiHttpBox(t);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A fixture with no settings file starts empty. */ }
  const setting = on => writeFileSync(file, JSON.stringify({ ...saved, items: { ...saved.items, typedFields: on } }));
  setting(true);
  const ids = ['Alpha item', 'Beta item'].map(title => {
    const added = box.cli(box.root, 'add', 'app', title, '--specs', 'G1', '--criterion', 'It holds a field.', '--brief', FIXTURE_BRIEF);
    return (added.result ?? added).item.item_id;
  });
  box.cli(box.root, 'field', 'declare', 'points', 'number');
  box.cli(box.root, 'field', 'set', String(ids[0]), 'points', '5');
  withFixtureBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'), board => relateItems(board, { by: 'coordinator', a: ids[0], b: ids[1], enabled: true }));
  const item = async id => (await box.call(`${box.path}/items/${id}`)).document;
  return { ids, item, setting };
}

test('clause 1: with items.typedFields on the item API sends fields and links, and with it off omits both [C7,#9835]', async t => {
  const { ids: [a, b], item, setting } = await fixture(t);
  const on = (await item(a)).item;
  assert.deepEqual(on.fields, [{ name: 'points', type: 'number', value: 5 }]);
  assert.deepEqual(on.links, [{ id: b, title: 'Beta item' }]);
  setting(false);
  const off = (await item(a)).item;
  assert.equal(Object.hasOwn(off, 'fields'), false);
  assert.equal(Object.hasOwn(off, 'links'), false);
  setting(true);
  assert.deepEqual((await item(a)).item.fields, [{ name: 'points', type: 'number', value: 5 }], 'turning it back on sends them again');
});
