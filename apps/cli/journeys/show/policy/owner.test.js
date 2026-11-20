/**
 * End to end on real repos, part three: foreign changes before claiming and cross-lane renames (L3, V4).
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
const { attackCommit, project } = e2e;

test('cli.journeys-show-policy-owner.foreign-changes-before-claiming-and-cross: foreign changes before claiming and cross-lane renames cannot hide from submit [L3,V4]', async t => {
  for (const mode of ['before-claim', 'rename', 'delete']) {
    const box = project('true');
    writeFileSync(join(box.repo, 'foreign file.txt'), 'coordinator-owned');
    box.git(box.repo, 'add', '-A');
    box.git(box.repo, 'commit', '-q', '-m', 'chore: foreign fixture');
    box.git(box.web, 'merge', '-q', '--ff-only', 'main');
    assert.equal(fixtureAdd(box.run, box.repo, 'web', mode, '--specs', 'G1').code, 0);
    if (mode === 'before-claim') {
      writeFileSync(join(box.web, 'foreign file.txt'), 'unauthorized pre-claim replacement');
      attackCommit(box, box.web);
    }
    assert.equal((await box.inProcess(box.web, 'claim', '1')).code, 0);
    mkdirSync(join(box.web, 'web'));
    if (mode === 'rename') box.git(box.web, 'mv', 'foreign file.txt', 'web/moved.txt');
    else if (mode === 'delete') box.git(box.web, 'rm', 'foreign file.txt');
    writeFileSync(join(box.web, 'web/index.html'), 'owned');
    attackCommit(box, box.web);
    await assertWaitsOnOwner(t, box, 1, await box.inProcess(box.web, 'submit', '1', '--json'), ['foreign file.txt'], mode);
  }
});
