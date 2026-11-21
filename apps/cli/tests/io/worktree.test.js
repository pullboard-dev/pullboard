/** Primary checkout discovery stays independent of linked worktree count for ordinary clones [C7,#12582]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after } from 'node:test';
import { test } from 'node:test';
import { realGitAdapter } from '../../../../packages/git/index.js';
import { withGitContractAdapter } from '../../../../packages/git/index.js';
import { runFixtureGit } from '../../../../packages/gate/tests/fixtures/child.js';
import { createE2eHelpers } from '../fixtures/e2e.js';
import { primaryCheckoutRoot } from '../../src/io/worktree.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { project, sandbox } = e2e;

function fixture(options = {}) {
  return project('true', sandbox(), { withWorktree: false, ...options });
}

function info(root, env) {
  const commonDir = runFixtureGit(['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: root, env });
  return { root, commonDir, isMain: false };
}

function observingGit(calls) {
  return {
    spawnSync(args, options) { calls.push(args); return realGitAdapter.spawnSync(args, options); },
    execFileSync(args, options) { calls.push(args); return realGitAdapter.execFileSync(args, options); },
    spawn(args, options) { calls.push(args); return realGitAdapter.spawn(args, options); },
  };
}

function median(values) {
  const ordered = [...values].sort((a, b) => a - b);
  return (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
}

test('cli.io-worktree.primary-root-from-files: clause 1: a linked worktree of an ordinary clone resolves its primary checkout without launching Git [C7,#12582]', () => {
  const box = fixture();
  const root = join(box.dir, 'ordinary-clone');
  box.git(box.dir, 'clone', '-q', box.repo, root);
  const linked = join(box.dir, 'linked');
  box.git(root, 'worktree', 'add', '-q', '--detach', linked, 'HEAD');
  const calls = [];
  const found = withGitContractAdapter(observingGit(calls), () => primaryCheckoutRoot(info(linked, box.env)));
  assert.equal(found, root);
  assert.deepEqual(calls, []);
});

test('cli.io-worktree.primary-root-falls-back-to-git: clause 2: a repository with a separate shared Git directory resolves its primary checkout through Git [C7,#12582]', () => {
  const box = fixture();
  const separate = join(box.dir, 'git-data');
  const clone = join(box.dir, 'separate-clone');
  box.git(box.dir, 'clone', '-q', `--separate-git-dir=${separate}`, box.repo, clone);
  const calls = [];
  const details = info(clone, box.env);
  const found = withGitContractAdapter(observingGit(calls), () => primaryCheckoutRoot(details));
  assert.equal(found, clone);
  assert.notEqual(info(clone, box.env).commonDir.split('/').at(-1), '.git');
  assert.ok(calls.length > 0, 'non-.git common dir kept the Git fallback');
});

test('cli.io-worktree.primary-root-cost-flat: clause 3: lookup median stays below 5 ms and at most twice as high with 40 linked worktrees [C7,#12582]', () => {
  const box = fixture();
  const { dir: folder, repo: root, env } = box;
  const one = join(folder, 'one');
  box.git(root, 'worktree', 'add', '-q', '--detach', one, 'HEAD');
  const many = [];
  for (let index = 0; index < 39; index += 1) {
    const path = join(folder, `linked-${index}`);
    box.git(root, 'worktree', 'add', '-q', '--detach', path, 'HEAD');
    many.push(path);
  }
  const measure = linked => {
    const target = info(linked, env);
    const samples = [];
    for (let index = 0; index < 20; index += 1) {
      const start = performance.now();
      assert.equal(primaryCheckoutRoot(target), root);
      samples.push(performance.now() - start);
    }
    return median(samples);
  };
  const oneMedian = measure(one);
  const manyMedian = measure(many.at(-1));
  assert.ok(manyMedian < 5, `40-worktree median was ${manyMedian.toFixed(3)} ms`);
  assert.ok(manyMedian <= oneMedian * 2, `40-worktree median ${manyMedian.toFixed(3)} ms exceeded 2x 1-worktree median ${oneMedian.toFixed(3)} ms`);
});
