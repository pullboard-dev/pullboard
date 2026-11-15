/** One submit reads HEAD and its tree through one memoized call and never asks for HEAD^ [C7,#6500]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { withGitAdapter } from '../../../git/index.js';
import { headCommitOf } from '../../index.js';
import { headRevs } from '../../index.js';

const COMMIT = 'a'.repeat(40), TREE = 'b'.repeat(40);

/** A Git that answers HEAD and its tree and records every launch, so the count is exact. */
function fakeGit() {
  const launches = [];
  const answer = args => {
    launches.push(args.filter(arg => !arg.startsWith('-c') && !/^(?:core|user)\./u.test(arg)).join(' '));
    return args.some(arg => arg.endsWith('^{tree}')) ? TREE + '\n' : COMMIT + '\n';
  };
  return { launches, adapter: {
    spawnSync: args => ({ status: 0, stdout: answer(args), stderr: '' }),
    execFileSync: args => answer(args),
    spawn() { throw new Error('no streaming Git here'); } } };
}

test('clause 2: the retry, the auto path and the head read share one memoized HEAD and tree answer [C7,#6500]', () => {
  const { launches, adapter } = fakeGit();
  withGitAdapter(adapter, () => {
    const root = '/nonexistent/pullboard-revs-fixture';
    assert.deepEqual(headRevs(root), { commit: COMMIT, tree: TREE });
    for (let read = 0; read < 3; read++) assert.equal(headCommitOf(root), COMMIT);
  });
  assert.equal(launches.filter(line => /rev-parse HEAD$/u.test(line)).length, 4 - 3, 'HEAD is resolved by Git at most once');
  assert.equal(launches.filter(line => /\^\{tree\}$/u.test(line)).length, 1, 'the tree is asked once');
});

test('clause 1: a submit-side HEAD read never asks for HEAD^, the first-parent log or the trunk config [C7,#6500]', () => {
  const { launches, adapter } = fakeGit();
  withGitAdapter(adapter, () => { headRevs('/nonexistent/pullboard-revs-other'); });
  assert.equal(launches.filter(line => /HEAD\^(?!\{)/u.test(line)).length, 0);
  assert.equal(launches.filter(line => /log .*--first-parent/u.test(line)).length, 0);
  assert.equal(launches.filter(line => /config .*pullboard\.trunk/u.test(line)).length, 0);
});
