/**
 * Next skips a held item from the listed row, and the git and node children that next, claim and submit start are
 * counted on a small board, so the spawn cuts that follow can lower a number [C7].
 */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fileFixtureItem } from '../../tests/fixtures/testkit.js';
import { spawnCounts } from '../../tests/fixtures/spawns.js';
import { spawnEnv } from '../../tests/fixtures/spawns.js';

/** A fixture project with the spawn counter loaded in every child, and the items filed untimed. */
function project(t) {
  const helpers = createE2eHelpers();
  t.after(() => helpers.cleanup());
  const box = helpers.project('true');
  const log = join(box.dir, 'spawns.log');
  const add = (title) => fileFixtureItem(box, box.repo, { lane: 'web', title, diagnose: false, args: ['--specs', 'G1'] }).item_id;
  return { box, log, add, counted: () => Object.assign(box.env, spawnEnv(log)) };
}

test('held item skipped from the listed row [C7]', (t) => {
  const { box, add } = project(t);
  const held = add('Held build');
  const open = add('Open build');
  const hold = box.run(box.repo, 'hold', String(held), '--reason', 'Fixture hold.', '--json');
  assert.equal(hold.code, 0, hold.err + hold.out);
  const next = box.run(box.web, 'next', '--build', '--json');
  assert.equal(next.code, 0, next.err + next.out);
  const parsed = JSON.parse(next.out);
  assert.equal(parsed.item?.item_id ?? parsed.item_id, open, 'next hands out the open item, not the held one');
});

test('spawn counts for next, claim and submit [C7]', (t) => {
  const { box, log, add, counted } = project(t);
  const ids = [add('Counted one'), add('Counted two')];
  counted();
  const say = (name, result) => { assert.equal(result.code, 0, `${name}: ${result.err}${result.out}`); const c = spawnCounts(log); console.log(`# spawns ${name}: ${JSON.stringify(c)}`); writeFileSync(log, ''); return c; };
  writeFileSync(log, '');
  const handed = box.run(box.web, 'next', '--build', '--json');
  const next = say('next', handed);
  const taken = JSON.parse(handed.out);
  const first = taken.item?.item_id ?? taken.item_id;
  const submitted = ids.find((id) => id !== first) ?? ids[0];
  const freed = box.run(box.web, 'release', String(first), '--reason', 'OTHER', '--note', 'Spawn sample.', '--no-next');
  assert.equal(freed.code, 0, freed.err + freed.out);
  writeFileSync(log, '');
  const claim = say('claim', box.run(box.web, 'claim', String(submitted), '--json'));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web', 'spawns.js'), 'export const spawns = 1;\n');
  box.git(box.web, 'add', '-A');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): spawn sample [G1]');
  writeFileSync(log, '');
  const submit = say('submit', box.run(box.web, 'submit', String(submitted), '--no-next'));
  for (const counts of [next, claim, submit]) {
    for (const key of ['git', 'node', 'total']) assert.equal(Number.isInteger(counts[key]), true);
  }
  assert.ok(next.total > 0 && claim.total > 0 && submit.total > 0, 'every command started children');
});
