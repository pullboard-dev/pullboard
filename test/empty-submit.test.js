/** A submit with no change against main is refused before any gate and names the folder with the work [C7,V4]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { fixtureAdd } from './testkit-fixture.js';

/** A claimed item whose commits sit in a sibling folder while the claiming checkout is back at main. */
function staleSeat(t, helpers) {
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = fixtureAdd(box.run, box.repo, 'web', 'empty submit', '--specs', 'G1', '--criterion', 'The feature is present.',
    '--check', 'test -f web/feature.txt', '--json');
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  assert.equal(box.run(box.web, 'claim', String(id)).code, 0);
  return { box, id };
}

test('a submit whose head equals main is refused EMPTY_SUBMIT and names the folder holding the commits [C7,V4]', t => {
  const helpers = createE2eHelpers();
  const { box, id } = staleSeat(t, helpers);
  const main = box.git(box.web, 'rev-parse', 'HEAD');
  const committed = helpers.commitFile(box, box.web, 'web/feature.txt', 'feature\n', `feat(web): add the feature [G1]\n\nPullboard-Item: #${id}`);
  assert.equal(committed.status, 0, committed.stderr);
  const work = join(box.dir, 'work-folder');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', work, box.git(box.web, 'rev-parse', 'HEAD'));
  box.git(box.web, 'reset', '-q', '--hard', main);
  const result = box.run(box.web, 'submit', String(id), '--no-next', '--json');
  assert.equal(result.code, 1, result.out);
  const refusal = JSON.parse(result.out).error;
  assert.equal(refusal.code, 'EMPTY_SUBMIT');
  assert.ok(refusal.message.includes(work), refusal.message);
  const shown = JSON.parse(box.run(box.repo, 'show', String(id), '--json').out);
  assert.doesNotMatch(JSON.stringify(shown), /queued gate/u);
});

test('an empty submit with no folder holding the item names the next step [C7,V4]', t => {
  const helpers = createE2eHelpers();
  const { box, id } = staleSeat(t, helpers);
  const result = box.run(box.web, 'submit', String(id), '--no-next', '--json');
  assert.equal(result.code, 1, result.out);
  const refusal = JSON.parse(result.out).error;
  assert.equal(refusal.code, 'EMPTY_SUBMIT');
  assert.match(refusal.message, /commit the work/u);
});
