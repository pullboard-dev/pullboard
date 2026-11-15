/**
 * End to end on real repos, part two: accepted-main merges and the frozen check at the submission (L3, V4, M3).
 */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { assertWaitsOnOwner } from '../../../tests/fixtures/submit/owner-wait.js';
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  attackCommit, historicalCheckSubmission, LIGHT_BRIEF, project,
} = e2e;

test('accepted-main merges carry foreign files without granting permission to alter them [L3,V4]', async t => {
  const box = project('true');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Main merge', '--specs', 'G1', '--criterion', 'foreign main object preserved').code, 0);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  writeFileSync(join(box.repo, 'coordinator.txt'), 'accepted main fixture');
  box.git(box.repo, 'add', 'coordinator.txt');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: coordinator fixture');
  box.git(box.web, 'merge', '-q', '--ff-only', 'main');
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/index.html'), 'app fixture');
  box.git(box.web, 'add', 'web/index.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): preserve main fixture [G1]');
  assert.equal((await box.inProcess(box.web, 'submit', '1')).code, 0, 'unchanged accepted-main foreign objects are allowed');
  const commit = box.git(box.web, 'rev-parse', 'HEAD');
  box.git(box.repo, 'merge', '-q', '--ff-only', 'web/one');
  assert.equal((await box.inProcess(box.repo, 'verify', '1', 'accept', '--as', 'coordinator', '--note', 'private accepted-main fixture')).code, 0);
  assert.equal((await box.inProcess(box.repo, 'doctor')).code, 0, 'the pre-merge main proof remains available for historical audit');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Alter foreign file', '--specs', 'G1', '--criterion', 'ownership remains enforced').code, 0);
  assert.equal((await box.inProcess(box.web, 'claim', '2')).code, 0);
  writeFileSync(join(box.web, 'coordinator.txt'), 'unauthorized replacement');
  attackCommit(box, box.web);
  await assertWaitsOnOwner(t, box, 2, await box.inProcess(box.web, 'submit', '2', '--json'), ['coordinator.txt']);
});

test('accept reruns the frozen check at the submission even when the reviewer repaired its HEAD [V4,M3]', async t => {
  const box = project('true');
  assert.equal(fixtureAdd(box.run, box.repo, 'web', 'Exact check', '--specs', 'G1', '--criterion', 'the original check passes', '--brief', LIGHT_BRIEF, '--check', 'test ! -f web/RED_CHECK').code, 0);
  assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
  mkdirSync(join(box.web, 'web'));
  writeFileSync(join(box.web, 'web/RED_CHECK'), 'red');
  const commit = attackCommit(box, box.web);
  const blocked = await box.inProcess(box.web, 'submit', '1', '--json');
  assert.equal(blocked.code, 0, blocked.out + blocked.err);
  assert.equal((await settleSubmit(t, box, JSON.parse(blocked.out))).gate.green, false, 'the settled gate is red on the frozen check even when the project gate passes');
  historicalCheckSubmission(box, commit); // Legacy receipts must still be independently checked.
  const review = join(box.dir, 'exact-review');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', review, commit);
  assert.equal(fixtureJoin(box.run, review, 'api').code, 0);
  box.git(review, 'rm', 'web/RED_CHECK');
  attackCommit(box, review); // Model the adversarial repair without disabling its lane hook.
  assert.equal((await box.inProcess(review, 'check', '1', '--yes')).code, 0, 'the reviewer HEAD alone is green');
  const refused = await box.inProcess(review, 'verify', '1', 'accept', '--note', 'reviewer repair is not submission proof', '--json');
  assert.equal(refused.code, 1);
  assert.equal(JSON.parse(refused.out).error.code, 'CHECK_RED');
  assert.equal(JSON.parse((await box.inProcess(review, 'show', '1', '--json')).out).item_status, 'submitted');
});
