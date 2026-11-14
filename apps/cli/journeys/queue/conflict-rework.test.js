/** @pullboard-test-loads packages/moves/src/io/selection.js packages/verify/src/logic/next.js apps/cli/src/io/commands/next.js */
/** Real Git and CLI: after a trunk conflict the builder takes the rework and the other seat stays a reviewer [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';

const helpers = createE2eHelpers();
after(helpers.cleanup);

test('clause 1: a conflicted head goes to its builder, the reviewer seat stays eligible, and each seat is told what to do [C7,V4]', async () => {
  const box = helpers.project('true');
  /** Demand real command success and its versioned result. */
  const json = (result) => { assert.equal(result.code, 0, result.out + result.err); return JSON.parse(result.out); };
  const id = json((await fixtureAdd(box.runLocal, box.repo, 'web', 'Show the list', '--criterion', 'web/list.html exists', '--json'))).item.item_id;
  json((await box.runLocal(box.web, 'claim', String(id), '--json')));
  mkdirSync(join(box.web, 'web'), { recursive: true });
  writeFileSync(join(box.web, 'web/list.html'), '<ul>from the branch</ul>\n');
  box.git(box.web, 'add', 'web/list.html');
  box.git(box.web, 'commit', '-q', '-m', 'feat(web): show the list [G1]');
  json((await box.runLocal(box.web, 'submit', String(id), '--wait', '--no-next', '--json')));
  // The second seat is in a lane with no work of its own, as a review seat is: an unrouted item is strong.
  const reviewer = join(box.dir, 'api-1');
  box.git(box.repo, 'worktree', 'add', '-q', reviewer, '-b', 'api/review-one');
  const reviewerId = json((await fixtureJoin(box.runLocal, reviewer, 'api', '--route', 'strong', '--json'))).agent;
  // Main lands its own version of the same file, so the submitted head no longer merges.
  mkdirSync(join(box.repo, 'web'), { recursive: true });
  writeFileSync(join(box.repo, 'web/list.html'), '<ol>from main</ol>\n');
  box.git(box.repo, 'add', 'web/list.html');
  box.git(box.repo, 'commit', '-q', '-m', 'feat(web): main lands its own list [G1]');

  const looked = await box.runLocal(reviewer, 'next');
  const all = `${looked.out}\n${looked.err}`;
  assert.equal(looked.code, 0, all);
  assert.match(looked.err, new RegExp(`returned #${id} to its builder unreviewed`, 'u'), all);
  assert.doesNotMatch(all, /moved from api to web/u, 'the reviewer seat is not moved into building');
  assert.doesNotMatch(all, new RegExp(`claimed #${id}:`, 'u'), 'the reviewer seat does not take the rework');
  assert.match(looked.out, new RegExp(`next: #${id} went back to its builder web-1 for rework, so this seat leaves it to them: run pullboard next again once web-1 resubmits it`, 'u'),
    'the reviewer seat is told what to do, not to end its turn');
  assert.equal(json((await box.runLocal(box.repo, 'show', String(id), '--json'))).item_status, 'open', 'the rework waits for its builder');

  const built = await box.runLocal(box.web, 'next');
  assert.equal(built.code, 0, `${built.out}\n${built.err}`);
  assert.match(built.out, new RegExp(`claimed #${id}:`, 'u'), 'the builder seat takes its own rework');
  const folder = /item folder: (.+?); seat web-1/u.exec(built.out)?.[1] ?? box.web;
  box.tryGit(folder, 'merge', '-q', 'main');
  writeFileSync(join(folder, 'web/list.html'), '<ol>from main and the branch</ol>\n');
  box.git(folder, 'add', 'web/list.html');
  box.git(folder, 'commit', '-q', '-m', 'chore(web): merge main into the list [G1]');
  json((await box.runLocal(folder, 'submit', String(id), '--wait', '--no-next', '--json')));

  const shown = (await box.runLocal(box.repo, 'show', String(id))).out;
  assert.match(shown, new RegExp(`eligible reviewers: [^\\n]*\\b${reviewerId}\\b`, 'u'), 'the reviewer seat can still review it');
  const reserved = json((await box.runLocal(reviewer, 'next', '--verify', '--json')));
  assert.equal(reserved.item.item_id, id, 'the reviewer seat reviews the resubmitted head');
});
