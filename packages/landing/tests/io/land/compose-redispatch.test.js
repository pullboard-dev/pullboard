/** @pullboard-test-input packages/landing/src/io/step/compose.js */
/** A runner-composed landing fast-forwards the coordinator when main is unmoved and re-dispatches once when it moved [C7,#10247]. */
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runFixtureGit } from '../../../../gate/tests/fixtures/child.js';
import { privateFixtureFiles } from '../../../../gate/tests/fixtures/child.js';
import { composeFollowingMain } from '../../../src/io/step/compose.js';

const ENV = { GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };

/** A repo whose primary checkout sits on main, and a separate detached batch worktree on the same base. */
function fixture(t) {
  const { root } = privateFixtureFiles('landing-compose-redispatch-');
  const { root: batchRoot } = privateFixtureFiles('landing-compose-redispatch-batch-');
  const sh = (cwd, ...args) => runFixtureGit(args, { cwd, env: ENV }).trim();
  sh(root, 'init', '-q', '-b', 'main');
  const commit = (name) => { writeFileSync(join(root, name), `${name}\n`); sh(root, 'add', '-A'); sh(root, 'commit', '-q', '-m', name); return sh(root, 'rev-parse', 'HEAD'); };
  const base = commit('base.txt');
  sh(root, 'worktree', 'add', '-q', '--detach', batchRoot, base);
  t.after(() => sh(root, 'worktree', 'remove', '--force', batchRoot));
  const state = { root, batch: { id: 'b1', root: batchRoot, base }, say() {} };
  return { root, batchRoot, sh, commit, base, state };
}

/** A stand-in runner compose: each call records the base it was dispatched on, runs `before`, and answers a tip built on that base. */
function runner(f, before = () => {}) {
  const calls = [];
  const compose = async state => {
    calls.push(state.batch.base);
    before(calls.length);
    const tip = f.sh(f.batchRoot, 'commit-tree', '-p', state.batch.base, '-m', `tip ${calls.length}`, `${state.batch.base}^{tree}`);
    return { tip, merges: new Map(), assigned: [], renames: [], writes: [] };
  };
  return { compose, calls };
}

test('landing.compose-redispatch.unmoved-main-takes-the-tip-by-update-ref: clause 1: when main still equals the batch base after the runner composed, the coordinator takes the tip with update-ref only and spawns no git merge [C7,#10247]', async t => {
  const f = fixture(t);
  const { compose, calls } = runner(f);
  const reflogBefore = f.sh(f.batchRoot, 'reflog', 'show', '--format=%gs', 'HEAD');
  const composed = await composeFollowingMain(f.state, [], { compose });
  assert.equal(calls.length, 1, 'one dispatch');
  assert.equal(f.sh(f.root, 'rev-parse', 'refs/pullboard/compose/b1'), composed.tip, 'the tip is held by update-ref');
  assert.equal(f.state.batch.base, f.base);
  assert.equal(f.sh(f.batchRoot, 'reflog', 'show', '--format=%gs', 'HEAD'), reflogBefore, 'no merge or checkout touched the batch HEAD');
  assert.equal(f.sh(f.root, 'rev-parse', 'main'), f.base, 'main did not move');
});

test('landing.compose-redispatch.moved-main-redispatches-once: clause 2: when main moved while the runner composed, the compose is dispatched once more from the new base and the second tip is taken [C7,#10247]', async t => {
  const f = fixture(t);
  let moved;
  const { compose, calls } = runner(f, n => { if (n === 1) moved = f.commit('moved.txt'); });
  const composed = await composeFollowingMain(f.state, [], { compose });
  assert.deepEqual(calls, [f.base, moved], 'the second dispatch builds on the new main');
  assert.equal(f.state.batch.base, moved);
  assert.equal(f.sh(f.root, 'rev-parse', 'refs/pullboard/compose/b1'), composed.tip);
  assert.equal(f.sh(f.batchRoot, 'rev-parse', `${composed.tip}^`), moved, 'the second tip sits on the new main');
});

test('landing.compose-redispatch.second-move-refuses-land-item-moved: clause 2: when main moves a second time the landing refuses LAND_ITEM_MOVED naming the next step and holds no tip [C7,#10247]', async t => {
  const f = fixture(t);
  const { compose, calls } = runner(f, n => { f.commit(`moved-${n}.txt`); });
  await assert.rejects(composeFollowingMain(f.state, [], { compose }), error => error.code === 'LAND_ITEM_MOVED' && /pullboard land/u.test(error.message));
  assert.equal(calls.length, 2, 'dispatched once more, not a third time');
  assert.throws(() => f.sh(f.root, 'rev-parse', '--verify', '-q', 'refs/pullboard/compose/b1'), 'no tip ref was written');
});
