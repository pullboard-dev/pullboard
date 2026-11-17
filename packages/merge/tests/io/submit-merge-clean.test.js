/** @pullboard-test-input source-cell packages/merge */
/** @pullboard-world-pin builds a real git repository in a private root; main and the builder branch each commit different files. */
/** The submit merge of main is written as objects only: the item folder stays clean and a second submit is not refused DIRTY [C7,V4,#3768]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeSubmissionMain } from '../../index.js';
import { fixture } from '../../../landing/tests/fixtures/plan.js';
import { git } from '../../../landing/tests/fixtures/plan.js';

/**
 * A builder checkout one commit ahead of a base, plus a main that moved on with a different file.
 *
 * @param {import('node:test').TestContext} t - Test context that removes the fixture and restores the identity variables.
 * @returns {object} The builder folder, the new main sha, the builder head and a git helper.
 */
function project(t) {
  const { root, put } = fixture(t);
  const keys = ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL'];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const identity = { GIT_AUTHOR_NAME: 'Merge fixture', GIT_AUTHOR_EMAIL: 'merge@example.invalid', GIT_COMMITTER_NAME: 'Merge fixture', GIT_COMMITTER_EMAIL: 'merge@example.invalid' };
  Object.assign(process.env, identity);
  t.after(() => { for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; } });
  const run = (...args) => git(root, ...args).trim();
  put('base.txt', 'base\n');
  run('add', '-A'); run('commit', '-q', '-m', 'base');
  const base = run('rev-parse', 'HEAD');
  run('checkout', '-q', '-b', 'build');
  put('builder.txt', 'builder\n');
  run('add', '-A'); run('commit', '-q', '-m', 'builder');
  const source = run('rev-parse', 'HEAD');
  run('checkout', '-q', '-b', 'trunk', base);
  put('trunk.txt', 'main\n');
  run('add', '-A'); run('commit', '-q', '-m', 'main');
  const main = run('rev-parse', 'HEAD');
  run('checkout', '-q', 'build');
  return { dir: root, git: run, main, source };
}

test('merge.submit.checkout-false-clean: clause 1: the submit merge of main leaves git status empty, HEAD and the folder where they were [C7,V4,#3768]', t => {
  const p = project(t);
  const result = mergeSubmissionMain(p.dir, p.main, { checkout: false });
  assert.equal(result.merged, true);
  assert.notEqual(result.commit, p.source);
  assert.equal(p.git('status', '--porcelain=v1', '--untracked-files=all'), '');
  assert.equal(p.git('rev-parse', 'HEAD'), p.source);
  assert.equal(p.git('rev-parse', 'refs/heads/build'), p.source);
  assert.equal(p.git('ls-files', 'trunk.txt'), '', 'main\'s file is not written into the folder');
  assert.deepEqual(p.git('show', '-s', '--format=%P', result.commit).split(' '), [p.source, p.main]);
});

test('merge.submit.second-not-dirty: clause 2: a second submit merge from the same folder is not refused DIRTY and composes the same tree [C7,V4,#3768]', t => {
  const p = project(t);
  const first = mergeSubmissionMain(p.dir, p.main, { checkout: false });
  const second = mergeSubmissionMain(p.dir, p.main, { checkout: false });
  assert.equal(second.merged, true);
  assert.equal(p.git('rev-parse', `${second.commit}^{tree}`), p.git('rev-parse', `${first.commit}^{tree}`));
  assert.equal(p.git('status', '--porcelain=v1', '--untracked-files=all'), '');
});
