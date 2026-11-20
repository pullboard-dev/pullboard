/** @pullboard-test-input source-cell seats */
/** The release snapshot launches no Git when the claim holds no snapshot to compare, and is unchanged otherwise [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../gate/tests/fixtures/child.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';
import { currentGitAdapter } from '../../../git/index.js';
import { realGitAdapter } from '../../../git/index.js';
import { withGitAdapter } from '../../../git/index.js';
import { claimWorktreeSnapshot } from '../../index.js';

/** A small real repository with one commit and one untracked file; removed when the test ends. */
function repository(t) {
  const files = privateFixtureFiles('pullboard-untouched-');
  const { root } = files;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const setup = (...args) => runFixtureSetupGit(['-c', 'user.name=T', '-c', 'user.email=t@example.com', ...args], { cwd: root });
  setup('init', '-q');
  files.write('a.txt', 'one\n');
  setup('add', 'a.txt');
  setup('commit', '-q', '-m', 'base');
  files.write('b.txt', 'two\n');
  return files;
}

/** A Git adapter that forwards to the real one and records every child it is asked to launch. */
function counting(launched) {
  const note = (method, args, options) => { launched.push(args[0]); return realGitAdapter[method](args, options); };
  return { ...realGitAdapter,
    spawnSync: (args, options) => note('spawnSync', args, options),
    execFileSync: (args, options) => note('execFileSync', args, options),
    spawn: (args, options) => note('spawn', args, options) };
}

test('seats.untouched.no-claim-snapshot-no-git: clause 1: with no claim snapshot given the snapshot is null and no Git child is launched [C7]', t => {
  const files = repository(t);
  const root = files.root;
  for (const claimSnapshot of [null, undefined, {}, { head: 'a'.repeat(40) }]) {
    const launched = [];
    const answer = withGitAdapter(counting(launched), () => {
      const result = claimWorktreeSnapshot(root, { claimSnapshot });
      if (currentGitAdapter() !== realGitAdapter) assert.deepEqual(launched, [], 'no Git child launched');
      return result;
    });
    assert.equal(answer, null, JSON.stringify(claimSnapshot));
  }
});

test('seats.untouched.same-digest-with-claim-snapshot: clause 1: with a claim snapshot given, or no options, the snapshot is the same head and digest as before [C7]', t => {
  const files = repository(t);
  const root = files.root;
  const plain = claimWorktreeSnapshot(root);
  assert.match(plain.head, /^[0-9a-f]{40,64}$/u);
  assert.match(plain.digest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(claimWorktreeSnapshot(root, { claimSnapshot: plain }), plain);
  assert.deepEqual(claimWorktreeSnapshot(root, {}), plain);
  assert.deepEqual(claimWorktreeSnapshot(root), plain, 'the same tree gives the same snapshot twice');
  files.write('b.txt', 'changed\n');
  assert.notEqual(claimWorktreeSnapshot(root, { claimSnapshot: plain }).digest, plain.digest, 'an edit still changes the digest');
});
