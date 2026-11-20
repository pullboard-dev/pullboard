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
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const {
  attackCommit, project,
} = e2e;

test('cli.journeys-show-policy-merge.accepted-main-merges-carry-foreign-files: accepted-main merges carry foreign files without granting permission to alter them [L3,V4]', async t => {
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
