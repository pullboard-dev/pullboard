/**
 * End to end on real repos, part three: accept reruns the frozen check at the submission (V4, M3).
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
import { settleSubmit } from '../../../tests/fixtures/submit/settle.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  attackCommit, historicalCheckSubmission, LIGHT_BRIEF, project,
} = e2e;

test('cli.journeys-show-policy-merge-rerun.accept-reruns-the-frozen-check-at: accept reruns the frozen check at the submission even when the reviewer repaired its HEAD [V4,M3]', async t => {
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
