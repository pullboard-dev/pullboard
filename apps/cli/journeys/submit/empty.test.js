/** @pullboard-test-input apps/cli/src/io/empty.js packages/codemap/src/io/cells/scripts/plan.js packages/gate/src/io/edges.js */
/** @pullboard-world-pin: clause 1 reads the shipped tree to prove the move: the old path is gone and the leaf exists. */
/** A submit with no change against main is refused before any gate and names the folder with the work [C7,V4]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** A claimed item whose commits sit in a sibling folder while the claiming checkout is back at main. */
async function staleSeat(t, helpers) {
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'empty submit', '--specs', 'G1', '--criterion', 'The feature is present.',
    '--check', 'test -f web/feature.txt', '--json'));
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal((await box.runLocal(box.web, 'claim', String(id))).code, 0);
  return { box, id };
}

test('a submit whose head equals main is refused EMPTY_SUBMIT and names the folder holding the commits [C7,V4]', async t => {
  const helpers = createE2eHelpers();
  const { box, id } = (await staleSeat(t, helpers));
  const main = box.git(box.web, 'rev-parse', 'HEAD');
  const committed = helpers.commitFile(box, box.web, 'web/feature.txt', 'feature\n', `feat(web): add the feature [G1]\n\nPullboard-Item: #${id}`);
  assert.equal(committed.status, 0, committed.stderr);
  const work = join(box.dir, 'work-folder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', work, box.git(box.web, 'rev-parse', 'HEAD'));
  box.git(box.web, 'reset', '-q', '--hard', main);
  const result = (await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json'));
  assert.equal(result.code, 1, result.out);
  const refusal = JSON.parse(result.out).error;
  assert.equal(refusal.code, 'EMPTY_SUBMIT');
  assert.ok(refusal.message.includes(work), refusal.message);
  const shown = JSON.parse((await box.runLocal(box.repo, 'show', String(id), '--json')).out);
  assert.doesNotMatch(JSON.stringify(shown), /queued gate/u);
});

test('an empty submit with no folder holding the item names the next step [C7,V4]', async t => {
  const helpers = createE2eHelpers();
  const { box, id } = (await staleSeat(t, helpers));
  const result = (await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json'));
  assert.equal(result.code, 1, result.out);
  const refusal = JSON.parse(result.out).error;
  assert.equal(refusal.code, 'EMPTY_SUBMIT');
  assert.match(refusal.message, /commit the work/u);
});

test('clause 1: src/empty-submit.js is gone and its leaf sits in the app:cli cell [C7]', () => {
  assert.equal(existsSync(join(ROOT, 'src/empty-submit.js')), false);
  assert.equal(existsSync(join(ROOT, 'apps/cli/src/io/empty.js')), true);
});

test('clause 2: the cells plan check and the cells edges check both pass [C7]', () => {
  for (const args of [['packages/codemap/src/io/cells/scripts/plan.js', '--check'], ['packages/gate/src/io/edges.js']]) {
    const run = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, `${args.join(' ')} exited ${run.status}: ${run.stderr}`);
  }
});
