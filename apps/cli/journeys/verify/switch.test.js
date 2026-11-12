/** verify moves a clean review worktree onto the submitted commit itself; a dirty one still refuses NOT_AT_COMMIT, naming its files [C7,#2907]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { fixtureAdd } from '../../tests/fixtures/testkit.js';

/** Run one command under its own fixture session, so the reviewer is independent of the builder. */
async function asSession(box, session, cwd, ...args) {
  const previous = box.env.CODEX_THREAD_ID;
  box.env.CODEX_THREAD_ID = session;
  try { return await box.runIn(cwd, ...args, ...(['submit', 'verify'].includes(args[0]) ? ['--no-next'] : [])); }
  finally {
    if (previous === undefined) delete box.env.CODEX_THREAD_ID;
    else box.env.CODEX_THREAD_ID = previous;
  }
}

test('clause 1 and clause 2: verify from a review worktree on another commit refuses while dirty, then switches to the submitted commit detached and continues [C7,#2907]', async t => {
  const helpers = createE2eHelpers();
  t.after(helpers.cleanup);
  const box = helpers.project('true');
  const added = await fixtureAdd(box.runIn, box.repo, 'web', 'Switching review', '--specs', 'G1', '--criterion', 'The page exists.', '--check', 'test -f web/page.html');
  assert.equal(added.code, 0, added.out + added.err);
  assert.equal((await asSession(box, 'sw-builder', box.web, 'claim', '1')).code, 0);
  assert.equal(helpers.commitFile(box, box.web, 'web/page.html', '<h1>Hi</h1>\n', 'feat(web): page [G1]').status, 0);
  const submitted = box.git(box.web, 'rev-parse', 'HEAD');
  const submit = await asSession(box, 'sw-builder', box.web, 'submit', '1');
  assert.equal(submit.code, 0, submit.out + submit.err);

  const reviewer = join(box.dir, 'sw-reviewer');
  box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer);
  const main = box.git(reviewer, 'rev-parse', 'HEAD');
  assert.notEqual(main, submitted, 'the review worktree starts on another commit');
  assert.equal((await asSession(box, 'sw-reviewer', reviewer, 'join', 'web')).code, 0);

  writeFileSync(join(reviewer, 'notes.txt'), 'scratch\n');
  const dirty = await asSession(box, 'sw-reviewer', reviewer, 'verify', '1', 'accept', '--note', 'The page exists.');
  assert.equal(dirty.code, 1, dirty.out + dirty.err);
  assert.match(dirty.err, /NOT_AT_COMMIT/u);
  assert.match(dirty.err, /notes\.txt/u, 'the dirty refusal names the file');
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), main, 'a dirty worktree is never switched');

  rmSync(join(reviewer, 'notes.txt'));
  const clean = await asSession(box, 'sw-reviewer', reviewer, 'verify', '1', 'accept', '--note', 'The page exists.');
  assert.doesNotMatch(clean.out + clean.err, /NOT_AT_COMMIT/u);
  assert.equal(clean.code, 0, clean.out + clean.err);
  assert.equal(box.git(reviewer, 'rev-parse', 'HEAD'), submitted, 'verify checked out the submitted commit itself');
  assert.notEqual(box.tryGit(reviewer, 'symbolic-ref', '-q', 'HEAD').status, 0, 'the review worktree is detached');
});
