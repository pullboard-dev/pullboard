/** pullboard list --field keeps the items whose typed field matches, behind items.typedFields (#9353, #1321) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { FIXTURE_BRIEF } from '../../tests/fixtures/api.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';

/** A fixture repo with three items and two declared fields; `on` sets items.typedFields first. */
async function fixture(t, on) {
  const box = apiHttpFixture(t);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A fixture with no settings file starts empty. */ }
  if (on) writeFileSync(file, JSON.stringify({ ...saved, items: { ...saved.items, typedFields: true } }));
  const run = args => runCliInProcess(args, { cwd: box.root, env: box.env });
  const ids = [];
  for (const title of ['Alpha item', 'Beta item', 'Gamma item']) {
    const added = await run(['add', 'app', title, '--specs', 'G1', '--criterion', 'It holds a field.', '--brief', FIXTURE_BRIEF, '--json']);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    ids.push((JSON.parse(added.stdout).result ?? JSON.parse(added.stdout)).item.item_id);
  }
  if (on) {
    assert.equal((await run(['field', 'declare', 'priority', 'choice', '--choices', 'low,high'])).status, 0);
    assert.equal((await run(['field', 'declare', 'points', 'number'])).status, 0);
    const set = async (id, name, value) => assert.equal((await run(['field', 'set', String(id), name, value])).status, 0);
    await set(ids[0], 'priority', 'high'); await set(ids[0], 'points', '5');
    await set(ids[1], 'priority', 'low'); await set(ids[1], 'points', '2');
    await set(ids[2], 'priority', 'high');
  }
  const listed = async (...args) => {
    const out = await run(['list', ...args, '--json']);
    return { out, ids: out.status === 0 ? (JSON.parse(out.stdout).result ?? JSON.parse(out.stdout)).items.map(item => item.item_id).sort((a, b) => a - b) : null };
  };
  return { ids, run, listed };
}

test('cli.journeys-list-field-filter.list-field-priority-high-lists-only: clause 1: list --field priority=high lists only the items whose priority field is high [C7,#9353]', async t => {
  const { ids, listed } = await fixture(t, true);
  assert.deepEqual((await listed('--field', 'priority=high')).ids, [ids[0], ids[2]]);
  assert.deepEqual((await listed('--field', 'priority!=high')).ids, [ids[1]]);
  assert.deepEqual((await listed()).ids, ids);
});

test('cli.journeys-list-field-filter.a-number-field-filters-with-a: clause 2: a number field filters with a comparison, and an unknown field name refuses with its next step [C7,#9353]', async t => {
  const { ids, listed } = await fixture(t, true);
  assert.deepEqual((await listed('--field', 'points>=3')).ids, [ids[0]]);
  assert.deepEqual((await listed('--field', 'points<5')).ids, [ids[1]]);
  const unknown = await listed('--field', 'size=big');
  assert.equal(unknown.out.status, 1);
  const error = JSON.parse(unknown.out.stdout).error;
  assert.equal(error.code, 'FIELD_UNKNOWN');
  assert.match(`${error.message} ${error.next ?? ''}`, /pullboard field declare/u);
});

test('cli.journeys-list-field-filter.with-items-typedfields-off-field-names: clause 2: with items.typedFields off --field names the setting and a plain list is unchanged [C7,#9353]', async t => {
  const { ids, listed } = await fixture(t, false);
  const refused = await listed('--field', 'priority=high');
  assert.equal(refused.out.status, 1);
  assert.equal(JSON.parse(refused.out.stdout).error.code, 'FIELDS_OFF');
  assert.deepEqual((await listed()).ids, ids);
});
