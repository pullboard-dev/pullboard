/** pullboard field declares a typed item field and sets it on an item, behind items.typedFields (#9351, #1321) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { FIXTURE_BRIEF } from '../../tests/fixtures/api.js';
import { withFixtureBoard } from '../../tests/fixtures/board.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

const boardFile = box => join(box.root, '.git', 'pullboard', 'board.sqlite');

/** A fixture repo with one item; `on` sets items.typedFields in the fixture's machine settings. */
async function fixture(t, on) {
  const box = apiHttpFixture(t);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A fixture with no settings file starts empty. */ }
  if (on) writeFileSync(file, JSON.stringify({ ...saved, items: { ...saved.items, typedFields: true } }));
  const added = await runCliInProcess(['add', 'app', 'Field item', '--specs', 'G1', '--criterion', 'It holds a field.', '--brief', FIXTURE_BRIEF, '--json'], { cwd: box.root, env: box.env });
  assert.equal(added.status, 0, added.stdout + added.stderr);
  const id = (JSON.parse(added.stdout).result ?? JSON.parse(added.stdout)).item.item_id;
  const field = (...args) => runCliInProcess(['field', ...args, '--json'], { cwd: box.root, env: box.env });
  return { box, id, field };
}

test('clause 1: field declare priority choice --choices low,high then field set priority high succeeds and the value is in the board [C7,#9351]', async t => {
  const { box, id, field } = await fixture(t, true);
  const declared = await field('declare', 'priority', 'choice', '--choices', 'low,high');
  assert.equal(declared.status, 0, declared.stdout + declared.stderr);
  const set = await field('set', String(id), 'priority', 'high');
  assert.equal(set.status, 0, set.stdout + set.stderr);
  const stored = withFixtureBoard(boardFile(box), board => board.db.prepare('SELECT field_name AS name, field_value AS value FROM item_field WHERE item_id=?').all(id));
  assert.deepEqual(stored.map(row => ({ ...row })), [{ name: 'priority', value: 'high' }]);
});

test('clause 2: a value of the wrong type is refused with FIELD_TYPE, and with items.typedFields off the command names the setting to turn on [C7,#9351]', async t => {
  const on = await fixture(t, true);
  assert.equal((await on.field('declare', 'priority', 'choice', '--choices', 'low,high')).status, 0);
  const wrong = await on.field('set', String(on.id), 'priority', 'urgent');
  assert.equal(wrong.status, 1);
  assert.equal(JSON.parse(wrong.stdout).error.code, 'FIELD_TYPE');
  const off = await fixture(t, false);
  const refused = await off.field('declare', 'priority', 'choice', '--choices', 'low,high');
  assert.equal(refused.status, 1);
  assert.match(JSON.parse(refused.stdout).error.message, /items\.typedFields/u);
});
