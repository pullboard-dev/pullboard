/** @pullboard-test-input source-cell apps/cli packages/store pages kernel */
/** Typed item fields end to end, behind items.typedFields: shown by show, export and the view, filtered by list and roadmap, and a free link shown on both items (#9365, #1321) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../../fixtures/api.js';
import { FIXTURE_BRIEF } from '../../../fixtures/api.js';
import { withFixtureBoard } from '../../../fixtures/board.js';
import { runCliInProcess } from '../../../fixtures/process.js';
import { relateItems } from '../../../../../../packages/store/index.js';
import { generateBoardKey } from '../../../../../../packages/kernel/index.js';
import { openPagedSnapshot } from '../../../../../../packages/pages/index.js';
import { writePagedSnapshot } from '../../../../../../packages/pages/index.js';

const ENGINE = 56;

/** A fixture repo with three items, items.typedFields on, two declared fields and values on the first two. */
async function fixture(t) {
  const box = apiHttpFixture(t);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A fixture with no settings file starts empty. */ }
  const run = args => runCliInProcess(args, { cwd: box.root, env: box.env });
  const ids = [];
  for (const title of ['Alpha item', 'Beta item', 'Gamma item']) {
    const added = await run(['add', 'app', title, '--specs', 'G1', '--criterion', 'It holds a field.', '--brief', FIXTURE_BRIEF, '--json']);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    ids.push((JSON.parse(added.stdout).result ?? JSON.parse(added.stdout)).item.item_id);
  }
  const milestone = await run(['milestone', ...['add'], 'Release', '--items', ids.join(','), '--reason', 'a roadmap with three items']);
  assert.equal(milestone.status, 0, milestone.stdout + milestone.stderr);
  const setting = on => writeFileSync(file, JSON.stringify({ ...saved, items: { ...saved.items, typedFields: on } }));
  setting(true);
  assert.equal((await run(['field', 'declare', 'priority', 'choice', '--choices', 'low,high'])).status, 0);
  assert.equal((await run(['field', 'declare', 'points', 'number'])).status, 0);
  const set = async (id, name, value) => assert.equal((await run(['field', 'set', String(id), name, value])).status, 0);
  await set(ids[0], 'priority', 'high'); await set(ids[0], 'points', '5');
  await set(ids[1], 'priority', 'low'); await set(ids[1], 'points', '2');
  const json = async args => {
    const out = await run([...args, '--json']);
    return { out, body: out.status === 0 ? (JSON.parse(out.stdout).result ?? JSON.parse(out.stdout)) : JSON.parse(out.stdout) };
  };
  return { box, ids, run, json, setting };
}

/** Seal one item row the way the relay writer does and open it as a phone reader would. */
async function viewOf(row) {
  const objects = new Map();
  const context = {
    key: await generateBoardKey(), boardId: 'c'.repeat(32), sequence: 7,
    put(object) { objects.set(object.id, object); },
    get(id) { return objects.get(id).bytes; },
    lookup() { return undefined; },
    remember() {},
  };
  const item = { title: 'Alpha item', lane: 'app', specs: ['G1'], status: 'open', criterion: 'c', brief: 'b', verdicts: [], history: [], thread: [], ...row };
  const document = { version: 1, tables: {
    board_meta: [{ meta_key: 'board_id', meta_value: context.boardId }, { meta_key: 'relay_applied_sequence', meta_value: '7' }, { meta_key: 'relay_engine_version', meta_value: String(ENGINE) }],
    shout: [], event: [], item: [{ item_id: item.id }], agent: [], verdict: [], sqlite_sequence: [],
  }, presentation: { version: 1, config: { name: 'Fixture board' }, state: {
    items: [item], agents: [], shouts: [], decisions: [], asked: [], events: [], holds: [], spec: [], practice: [], lanes: ['app'], owning: ['app'],
  }, shouts: [] } };
  const root = await writePagedSnapshot(document, context);
  return openPagedSnapshot(root, context, { maxEngine: ENGINE });
}

test('cli.journeys-show-fields.a-typed-field-shows-in-show: clause 1: a typed field shows in show, export and the view [C7,#9365]', async t => {
  const { ids: [a], run, json } = await fixture(t);
  const shown = await run(['show', String(a)]);
  assert.match(shown.stdout, /^fields:\n {2}points \(number\): 5\n {2}priority \(choice\): high$/mu);
  const fields = [{ name: 'points', type: 'number', value: 5 }, { name: 'priority', type: 'choice', value: 'high' }];
  assert.deepEqual((await json(['show', String(a)])).body.fields, fields);
  const exported = JSON.parse((await run(['export'])).stdout);
  assert.deepEqual(exported.fields[a], fields);
  const page = await viewOf({ id: a, fields: (await json(['show', String(a)])).body.fields });
  const boot = await page.presentation();
  assert.deepEqual(boot.state.items[0].fields, fields, 'the view first screen shows the field');
  assert.deepEqual((await page.item(a)).fields, fields);
});

test('cli.journeys-show-fields.list-and-roadmap-filter-by-a: clause 2: list and roadmap filter by a field, and with items.typedFields off the same filter refuses [C7,#9365]', async t => {
  const { ids, json, setting } = await fixture(t);
  const listed = async (...args) => (await json(['list', ...args])).body.items.map(item => item.item_id).sort((x, y) => x - y);
  assert.deepEqual(await listed('--field', 'priority=high'), [ids[0]]);
  assert.deepEqual(await listed('--field', 'points<5'), [ids[1]]);
  assert.deepEqual(await listed(), ids);
  const roadmap = (await json(['roadmap', '--field', 'priority=low'])).body.milestones;
  assert.deepEqual(roadmap.flatMap(entry => entry.items.map(item => item.id)), [ids[1]]);
  setting(false);
  for (const command of ['list', 'roadmap']) {
    const refused = await json([command, '--field', 'priority=high']);
    assert.equal(refused.out.status, 1);
    assert.equal(JSON.parse(refused.out.stdout).error.code, 'FIELDS_OFF');
  }
});

test('cli.journeys-show-fields.a-free-link-is-shown-on: clause 2: a free link is shown on both items [C7,#9365]', async t => {
  const { box, ids: [a, b], run, json } = await fixture(t);
  assert.doesNotMatch((await run(['show', String(a)])).stdout, /^related links/mu);
  withFixtureBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'), board => relateItems(board, { by: 'coordinator', a, b, enabled: true }));
  assert.match((await run(['show', String(a)])).stdout, new RegExp(`^related links:\\n {2}#${b} Beta item$`, 'mu'));
  assert.match((await run(['show', String(b)])).stdout, new RegExp(`^related links:\\n {2}#${a} Alpha item$`, 'mu'));
  assert.deepEqual((await json(['show', String(a)])).body.relatedLinks, [{ id: b, title: 'Beta item' }]);
});
