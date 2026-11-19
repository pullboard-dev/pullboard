/** With laneMode off the claimed item owns the cells of the files its bar names; with it on the lane folders still decide [C7,#8907]. */
import assert from 'node:assert/strict';
import {
  rmSync,
} from 'node:fs';
import {
  test,
} from 'node:test';
import {
  submissionPaths,
} from '../../../../src/io/trusted/policy.js';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../../../../gate/tests/fixtures/child.js';

/** The arguments that start each fixture repository on its own main branch. */
const REPOSITORY = ['init', '-q', '-b', 'main'];

/** One private repository whose main declares a lane and the lane mode, plus a candidate that edits the given paths. */
function candidate(t, laneMode, edited) {
  const { root, write: put } = privateFixtureFiles('pullboard-policy-cells-');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  /** Run the shared real-Git fixture helper with this isolated repository and identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  git(...REPOSITORY);
  put('pullboard.json', JSON.stringify({ gate: 'true', laneMode, lanes: { web: { owns: ['web/'], specs: ['G1'] } } }) + '\n');
  for (const path of ['packages/alpha/src/a.js', 'packages/alpha/tests/a.test.js', 'packages/beta/src/b.js']) put(path, 'original\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  for (const path of edited) put(path, 'edited\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'item work');
  const commit = git('rev-parse', 'HEAD');
  const item = { item_lane: 'web', item_claim_head: base, item_frozen: JSON.stringify({ policy: { commit: base } }),
    item_brief: 'Slice.\nFiles:\n- packages/alpha/src/a.js\n- packages/alpha/tests/a.test.js\nCaller files: packages/beta/src/b.js:3.\n' };
  return { root, item, commit, base };
}

test('sandbox.io-trusted-policy-cells.lanes-off-own-cells-pass: clause 1: with laneMode off a commit touching only the cells of the named files passes [C7,#8907]', t => {
  const box = candidate(t, 'off', ['packages/alpha/src/a.js', 'packages/alpha/tests/a.test.js']);
  assert.deepEqual(submissionPaths(box.root, box.item, box.commit, { mainCommit: box.base }).sort(),
    ['packages/alpha/src/a.js', 'packages/alpha/tests/a.test.js']);
});

test('sandbox.io-trusted-policy-cells.lanes-off-foreign-cell-refused: clause 2: with laneMode off a path outside the named cells is refused OUTSIDE_LANE naming it [C7,#8907]', t => {
  const box = candidate(t, 'off', ['packages/alpha/src/a.js', 'packages/beta/src/b.js']);
  assert.throws(() => submissionPaths(box.root, box.item, box.commit, { mainCommit: box.base }),
    error => error.code === 'OUTSIDE_LANE' && error.message.includes('packages/beta/src/b.js') && !error.message.includes('packages/alpha'));
});

test('sandbox.io-trusted-policy-cells.lanes-on-unchanged: clause 2: with laneMode on the named cells are not owned and the lane folders decide [C7,#8907]', t => {
  const box = candidate(t, 'on', ['packages/alpha/src/a.js']);
  assert.throws(() => submissionPaths(box.root, box.item, box.commit, { mainCommit: box.base }),
    error => error.code === 'OUTSIDE_LANE' && error.message.includes('packages/alpha/src/a.js'));
});
