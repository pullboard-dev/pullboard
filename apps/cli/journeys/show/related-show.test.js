/** pullboard show lists an item's free related links on both items, behind items.typedFields (#9356, #1321) [C7]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../tests/fixtures/api.js';
import { FIXTURE_BRIEF } from '../../tests/fixtures/api.js';
import { withFixtureBoard } from '../../tests/fixtures/board.js';
import { runCliInProcess } from '../../tests/fixtures/process.js';
import { relateItems } from '../../../../packages/store/index.js';

/** A fixture repo with two items and items.typedFields on. */
async function fixture(t) {
  const box = apiHttpFixture(t);
  const file = join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  let saved = {};
  try { saved = JSON.parse(readFileSync(file, 'utf8')); } catch { /* A fixture with no settings file starts empty. */ }
  writeFileSync(file, JSON.stringify({ ...saved, items: { ...saved.items, typedFields: true } }));
  const run = args => runCliInProcess(args, { cwd: box.root, env: box.env });
  const ids = [];
  for (const title of ['First linked item', 'Second linked item']) {
    const added = await run(['add', 'app', title, '--specs', 'G1', '--criterion', 'It holds a link.', '--brief', FIXTURE_BRIEF, '--json']);
    assert.equal(added.status, 0, added.stdout + added.stderr);
    ids.push((JSON.parse(added.stdout).result ?? JSON.parse(added.stdout)).item.item_id);
  }
  return { box, ids, run };
}

test('cli.journeys-show-related-show.after-relating-two-items-show-on: clause 1: after relating two items, show on each lists the other under related links [C7,#9356]', async t => {
  const { box, ids: [a, b], run } = await fixture(t);
  withFixtureBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'), board => relateItems(board, { by: 'coordinator', a, b, enabled: true }));
  const first = await run(['show', String(a)]);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, new RegExp(`^related links:\\n {2}#${b} Second linked item$`, 'mu'));
  const second = await run(['show', String(b)]);
  assert.match(second.stdout, new RegExp(`^related links:\\n {2}#${a} First linked item$`, 'mu'));
  const json = JSON.parse((await run(['show', String(a), '--json'])).stdout);
  assert.deepEqual((json.result ?? json).relatedLinks, [{ id: b, title: 'Second linked item' }]);
});

test('cli.journeys-show-related-show.an-item-with-no-related-link: clause 2: an item with no related link prints no related links line [C7,#9356]', async t => {
  const { ids: [a], run } = await fixture(t);
  const shown = await run(['show', String(a)]);
  assert.equal(shown.status, 0, shown.stdout + shown.stderr);
  assert.doesNotMatch(shown.stdout, /^related links/mu);
  assert.equal(Object.hasOwn(JSON.parse((await run(['show', String(a), '--json'])).stdout).result ?? {}, 'relatedLinks'), false);
});
