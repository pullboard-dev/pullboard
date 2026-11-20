/** add and edit take every dependency named by --after: given once per id, or as comma and space separated text, never only the last [C7,#11839]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as store from '../../../../../packages/store/index.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { onBoard } from '../../fixtures/land/board.js';
import { fixtureAdd } from '../../fixtures/testkit.js';

const GOOD = '1. the handler prints OK [command]';

/** A scratch project with three open items and helpers that add, edit and read an item's after list back from the board. */
async function project(t) {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const add = (title, ...more) => fixtureAdd(box.runLocal, box.repo, 'web', title, '--criterion', GOOD, ...more, '--json');
  const ids = [];
  for (const title of ['First', 'Second', 'Third']) {
    const first = await add(title);
    assert.equal(first.code, 0, first.err + first.out);
    ids.push(JSON.parse(first.out).item.item_id);
  }
  const edit = (id, ...args) => box.runLocal(box.repo, 'edit', String(id), ...args, '--json');
  const after = async id => String((await onBoard(box, board => store.getItem(board, id))).item_after ?? '').split(/[,\s]+/u).filter(Boolean);
  return { ids, add, edit, after };
}

test('cli.journeys-add-after.several-ids: clause 1: add with --after once per id, and with comma and space separated text, files an item after all three ids in the order given [C7,#11839]', async t => {
  const { ids, add, after } = await project(t);
  const expected = ids.map(String);
  const repeated = await add('Repeated', ...ids.flatMap(id => ['--after', String(id)]));
  assert.equal(repeated.code, 0, repeated.err + repeated.out);
  assert.deepEqual(await after(JSON.parse(repeated.out).item.item_id), expected, 'a repeated --after keeps every id');
  const text = await add('Text', '--after', `${ids[0]},${ids[1]} ${ids[2]}`);
  assert.equal(text.code, 0, text.err + text.out);
  assert.deepEqual(await after(JSON.parse(text.out).item.item_id), expected, 'comma and space separated text keeps every id');
});

test('cli.journeys-add-after.bad-id-refused: clause 2: an --after id that names no item is refused with a message naming that id, never dropped silently [C7,#11839]', async t => {
  const { ids, add } = await project(t);
  const refused = await add('Bad', '--after', String(ids[0]), '--after', '987654');
  assert.notEqual(refused.code, 0, refused.out + refused.err);
  assert.match(refused.out + refused.err, /987654/u, 'the refusal names the unknown id');
});

test('cli.journeys-add-after.edit-repeats: clause 3: edit with --after once per id replaces the after list with all of them, and --after none still clears it [C7,#11839]', async t => {
  const { ids, add, edit, after } = await project(t);
  const filed = await add('Edited');
  const id = JSON.parse(filed.out).item.item_id;
  const replaced = await edit(id, ...ids.flatMap(other => ['--after', String(other)]));
  assert.equal(replaced.code, 0, replaced.err + replaced.out);
  assert.deepEqual(await after(id), ids.map(String), 'a repeated --after replaces the list with every id');
  const cleared = await edit(id, '--after', 'none');
  assert.equal(cleared.code, 0, cleared.err + cleared.out);
  assert.deepEqual(await after(id), [], '--after none clears the list');
});
