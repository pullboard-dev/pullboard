/** @pullboard-test-input packages/landing/src/io/step/revert.js */
/** The pull-out revert undoes a landed merge on the trunk tip in a real repository, and a conflicting one changes nothing [M2,R3,#9097]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureSetupGit } from '../../../../gate/tests/fixtures/child.js';
import { cellRepo } from '../../../../store/tests/fixtures/cell.js';
import { revertLanded } from '../../../src/io/step/revert.js';

/** A real repository on main with an identity of its own, and a git runner in it. */
function trunkRepo(t) {
  const repo = cellRepo(t, { real: true });
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  const git = (...args) => runFixtureSetupGit(args, { cwd: repo.root, env });
  git('config', 'user.name', 'Lander');
  git('config', 'user.email', 'lander@example.invalid');
  repo.put('shared.txt', 'one\ntwo\nthree\n');
  repo.commitAll();
  return { ...repo, git };
}

/** Land a branch that writes `files` onto main with a --no-ff merge, as the lander does; returns the merge commit. */
function land(repo, files) {
  repo.git('checkout', '-q', '-b', 'item');
  for (const [path, body] of Object.entries(files)) repo.put(path, body);
  repo.commitAll();
  repo.git('checkout', '-q', 'main');
  repo.git('merge', '-q', '--no-ff', 'item', '-m', 'feat(web): the item lands [G1]');
  repo.git('branch', '-q', '-D', 'item');
  return repo.git('rev-parse', 'HEAD');
}

/** The checkout's HEAD, whether a revert is in progress, and its status, to show a call left the checkout alone. */
function checkoutState(repo) {
  return { head: repo.git('rev-parse', 'HEAD'), branch: repo.git('symbolic-ref', '--short', 'HEAD'), reverting: existsSync(join(repo.root, '.git', 'REVERT_HEAD')),
    status: repo.git('status', '--porcelain', '--untracked-files=no') };
}

test('clause 1: revertLanded commits git revert -m 1 of a landed merge on the trunk tip and returns the revert sha [M2,R3,#9097]', t => {
  const repo = trunkRepo(t);
  const merged = land(repo, { 'web/x.js': 'landed\n', 'shared.txt': 'one\ntwo\nthree\nfour\n' });
  repo.put('api/y.js', 'later work\n');
  const tip = repo.commitAll();
  const before = checkoutState(repo);
  const result = revertLanded(repo.root, merged, 'main');
  assert.match(result.commit, /^[a-f0-9]{40}$/u, 'the new revert sha is returned');
  assert.equal(result.trunk, tip);
  assert.equal(repo.git('rev-list', '--parents', '-n', '1', result.commit), `${result.commit} ${tip}`, 'the revert sits on the trunk tip, one parent');
  assert.deepEqual(checkoutState(repo), before, 'the checkout is untouched');
  assert.match(repo.git('log', '-1', '--format=%B', result.commit), new RegExp(`This reverts commit ${merged}, reversing\\nchanges made to`, 'u'));
  // The same tree `git revert -m 1` writes: the landed change is gone, the later trunk work stays.
  repo.git('checkout', '-q', '--detach', tip);
  repo.git('-c', 'core.hooksPath=/dev/null', 'revert', '--no-edit', '-m', '1', merged);
  assert.equal(repo.git('rev-parse', `${result.commit}^{tree}`), repo.git('rev-parse', 'HEAD^{tree}'), 'the tree matches git revert -m 1');
  assert.equal(repo.git('show', `${result.commit}:shared.txt`), 'one\ntwo\nthree');
  assert.equal(repo.git('show', `${result.commit}:api/y.js`), 'later work');
  assert.throws(() => repo.git('cat-file', '-e', `${result.commit}:web/x.js`));
});

test('clause 1: revertLanded reverts a non-merge landed commit with a plain revert [M2,R3,#9097]', t => {
  const repo = trunkRepo(t);
  repo.put('web/x.js', 'landed\n');
  const landed = repo.commitAll();
  repo.put('api/y.js', 'later work\n');
  const tip = repo.commitAll();
  const result = revertLanded(repo.root, landed, tip, { message: 'revert(web): pull out the item [M2]' });
  assert.equal(repo.git('rev-parse', `${result.commit}^`), tip);
  assert.equal(repo.git('log', '-1', '--format=%s', result.commit), 'revert(web): pull out the item [M2]', 'a caller-given message is used');
  repo.git('checkout', '-q', '--detach', tip);
  repo.git('-c', 'core.hooksPath=/dev/null', 'revert', '--no-edit', landed);
  assert.equal(repo.git('rev-parse', `${result.commit}^{tree}`), repo.git('rev-parse', 'HEAD^{tree}'), 'the tree matches git revert');
});

test('clause 2: a conflicting revert returns the conflicted paths and leaves the checkout at the trunk tip with no revert in progress [M2,R3,#9097]', t => {
  const repo = trunkRepo(t);
  const merged = land(repo, { 'web/x.js': 'landed\n', 'shared.txt': 'one\nTWO by the item\nthree\n' });
  repo.put('shared.txt', 'one\nTWO rewritten on trunk\nthree\n');
  const tip = repo.commitAll();
  const before = checkoutState(repo);
  const result = revertLanded(repo.root, merged, 'main');
  assert.deepEqual(result, { conflicts: ['shared.txt'], trunk: tip }, 'the conflicted paths are named and no commit is returned');
  assert.deepEqual(checkoutState(repo), before, 'the checkout stays at the trunk tip, clean, with no revert in progress');
  assert.equal(before.head, tip);
  assert.equal(repo.git('rev-parse', 'refs/heads/main'), tip, 'trunk did not move');
});

test('clause 2: a landed commit the repository does not hold is refused PULL_OUT_REVERT [M2,R3,#9097]', t => {
  const repo = trunkRepo(t);
  assert.throws(() => revertLanded(repo.root, 'f'.repeat(40), 'main'), { code: 'PULL_OUT_REVERT' });
});
