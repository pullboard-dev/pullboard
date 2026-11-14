/** After submit composes main into an item folder, the folder's index and working tree match the new head [C7,V4,#3768]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../../tests/fixtures/testkit.js';

test('clause 1: an automatic main merge touching many files leaves the item folder clean, and a second submit is not refused DIRTY [C7,V4,#3768]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = (await fixtureAdd(box.runLocal, box.repo, 'web', 'folder after merge', '--specs', 'G1', '--criterion', 'The feature is present.',
    '--check', 'test -f web/feature.txt', '--json'));
  assert.equal(added.code, 0, added.err);
  const id = JSON.parse(added.out).item.item_id;
  const claimed = (await box.runLocal(box.web, 'claim', String(id)));
  assert.equal(claimed.code, 0, `${claimed.err}\n${claimed.out}`);
  assert.equal(helpers.commitFile(box, box.web, 'web/feature.txt', 'feature\n', 'feat(web): add feature [G1]').status, 0);
  mkdirSync(join(box.repo, 'web/many'), { recursive: true });
  for (let n = 0; n < 40; n += 1) writeFileSync(join(box.repo, `web/many/file-${n}.txt`), `main ${n}\n`);
  box.git(box.repo, 'add', 'web/many');
  box.git(box.repo, 'commit', '-q', '-m', 'docs: advance main by many files');
  const first = (await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json'));
  assert.equal(first.code, 0, `${first.err}\n${first.out}`);
  const head = box.git(box.web, 'rev-parse', 'HEAD');
  assert.equal(box.git(box.web, 'show', '-s', '--format=%P', head).split(' ').length, 2, 'submit composed main into the builder branch');
  assert.equal(box.git(box.web, 'status', '--porcelain', '--untracked-files=all'), '');
  assert.equal(box.git(box.web, 'diff', '--stat', 'HEAD'), '');
  const second = (await box.runLocal(box.web, 'submit', String(id), '--no-next', '--json'));
  assert.doesNotMatch(`${second.err}\n${second.out}`, /DIRTY/u);
});
