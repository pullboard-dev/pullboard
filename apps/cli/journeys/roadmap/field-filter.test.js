/** pullboard roadmap --field keeps the items whose typed field matches, behind items.typedFields (#9354, #1321) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { FIXTURE_BRIEF } from '../../tests/fixtures/api.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { fileFixtureItem } from '../../../../packages/gate/tests/fixtures/testkit.js';

/** A fixture repo with three items in one milestone; `on` sets items.typedFields and tags two items topic=relay. */
async function fixture(t, on) {
  const box = apiHttpFixture(t);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A fixture with no settings file starts empty. */ }
  if (on) writeFileSync(file, JSON.stringify({ ...saved, items: { ...saved.items, typedFields: true } }));
  const run = args => runCliInProcess(args, { cwd: box.root, env: box.env });
  const command = (...args) => run(args);
  const ids = [];
  for (const title of ['Alpha item', 'Beta item', 'Gamma item']) {
    const item = await fileFixtureItem(box, box.root, { lane: 'app', title, criterion: 'It holds a field.', brief: FIXTURE_BRIEF, args: ['--specs', 'G1'], run: (root, ...args) => runCliInProcess(args, { cwd: root, env: box.env }) });
    ids.push(item.item_id);
  }
  const milestone = await command('milestone', 'add', 'Release', '--items', ids.join(','), '--reason', 'a roadmap with three items');
  assert.equal(milestone.status, 0, milestone.stdout + milestone.stderr);
  if (on) {
    assert.equal((await run(['field', 'declare', 'topic', 'choice', '--choices', 'relay,view'])).status, 0);
    for (const [id, value] of [[ids[0], 'relay'], [ids[1], 'view'], [ids[2], 'relay']]) assert.equal((await run(['field', 'set', String(id), 'topic', value])).status, 0);
  }
  const roadmap = async (...args) => {
    const out = await run(['roadmap', ...args, '--json']);
    const milestones = out.status === 0 ? (JSON.parse(out.stdout).result ?? JSON.parse(out.stdout)).milestones : null;
    return { out, milestones, ids: milestones?.flatMap(entry => entry.items.map(item => item.id)).sort((a, b) => a - b) };
  };
  return { ids, roadmap, run };
}

test('cli.journeys-roadmap-field-filter.roadmap-field-topic-relay-shows-only: clause 1: roadmap --field topic=relay shows only the items whose topic field is relay, with the progress counts computed over those items [C7,#9354]', async t => {
  const { ids, roadmap, run } = await fixture(t, true);
  const filtered = await roadmap('--field', 'topic=relay');
  assert.deepEqual(filtered.ids, [ids[0], ids[2]]);
  const [release] = filtered.milestones;
  assert.equal(release.total, 2);
  assert.equal(release.landed, 0);
  assert.equal(release.summary.total, 2);
  const text = await run(['roadmap', '--field', 'topic=relay']);
  assert.match(text.stdout, /Release: 0\/2 landed/u);
  assert.doesNotMatch(text.stdout, /Beta item/u);
});

test('cli.journeys-roadmap-field-filter.without-the-flag-the-roadmap-output: clause 2: without the flag the roadmap output is unchanged, and with items.typedFields off --field names the setting [C7,#9354]', async t => {
  const on = await fixture(t, true);
  const all = await on.roadmap();
  assert.deepEqual(all.ids, on.ids);
  assert.equal(all.milestones[0].total, 3);
  const off = await fixture(t, false);
  const plain = await off.roadmap();
  assert.deepEqual(plain.ids, off.ids);
  const refused = await off.roadmap('--field', 'topic=relay');
  assert.equal(refused.out.status, 1);
  assert.equal(JSON.parse(refused.out.stdout).error.code, 'FIELDS_OFF');
});
