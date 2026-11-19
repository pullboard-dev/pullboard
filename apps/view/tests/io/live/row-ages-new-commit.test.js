/** After a new commit, the view's state read names the newest commit's row ages, not the previous one [C7]. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import { cellBoard } from '../../../../../packages/store/tests/fixtures/cell.js';
import { cellProject } from '../../../../../packages/store/tests/fixtures/cell.js';
import { projectState } from '../../../src/io/serve.js';

test('view.x-io-live-row-ages-new-commit.clause-1-serve-returns-row-age-data: clause 1: serve returns row-age data for the newest commit right after a new commit lands [C7]', async t => {
  const project = cellProject(t, { real: true }), board = cellBoard(t, project.boardFile);
  const options = { board, rowAgesLater: true };
  let state = projectState(project.repo, options);
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline && Object.values(state.rowAgesAt).every(at => at === null)) {
    await new Promise(done => setImmediate(done));
    state = projectState(project.repo, options);
  }
  const identity = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const git = (...args) => execFileSync('git', args, { cwd: project.repo, encoding: 'utf8', env: identity }).trim();
  const before = git('rev-parse', 'HEAD');
  assert.ok(Object.values(state.rowAgesAt).every(at => at === before), 'ages were kept for the first commit');
  git('update-ref', 'HEAD', git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'chore: next commit'));
  const head = git('rev-parse', 'HEAD');
  assert.notEqual(head, before);
  const after = projectState(project.repo, options);
  assert.ok(Object.values(after.rowAgesAt).every(at => at === head), 'the read right after the commit names the new HEAD');
});
