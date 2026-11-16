/** One submit reads HEAD and its tree through one memoized call and never asks for HEAD^ [C7,#6500]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { withGitAdapter } from '../../../git/index.js';
import { headCommitOf } from '../../index.js';
import { headRevs } from '../../index.js';

const TREE = 'b'.repeat(40), ROOT = fileURLToPath(new URL('../../../..', import.meta.url));

/** A Git that answers HEAD and its tree and records every launch, so the count is exact. */
function fakeGit() {
  const launches = [];
  const answer = args => {
    launches.push(args.filter(arg => !arg.startsWith('-c') && !/^(?:core|user)\./u.test(arg)).join(' '));
    return TREE + '\n';
  };
  return { launches, adapter: {
    spawnSync: args => ({ status: 0, stdout: answer(args), stderr: '' }),
    execFileSync: args => answer(args),
    spawn() { throw new Error('no streaming Git here'); } } };
}

test('clause 2: the retry, the auto path and the head read share one memoized HEAD and tree answer [C7,#6500]', () => {
  const { launches, adapter } = fakeGit();
  withGitAdapter(adapter, () => {
    const first = headRevs(ROOT);
    assert.equal(first.tree, TREE);
    for (let read = 0; read < 3; read++) assert.equal(headCommitOf(ROOT), first.commit);
  });
  assert.equal(launches.filter(line => /rev-parse HEAD$/u.test(line)).length, 0, 'the checkout answers HEAD without a Git launch');
  assert.equal(launches.filter(line => /\^\{tree\}$/u.test(line)).length, 1, 'the tree is asked once');
});

test('clause 1: a submit-side HEAD read never asks for HEAD^, the first-parent log or the trunk config [C7,#6500]', () => {
  const { launches, adapter } = fakeGit();
  withGitAdapter(adapter, () => { headRevs(ROOT); });
  assert.equal(launches.filter(line => /HEAD\^(?!\{)/u.test(line)).length, 0);
  assert.equal(launches.filter(line => /log .*--first-parent/u.test(line)).length, 0);
  assert.equal(launches.filter(line => /config .*pullboard\.trunk/u.test(line)).length, 0);
});
