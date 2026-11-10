/** Real Git ancestry and explicitly synthetic frozen-policy records preserve lane authority [L3,V4]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  tmpdir,
} from 'node:os';
import {
  dirname,
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  submissionPaths,
} from '../../../../src/io/trusted/policy.js';
import {
  runFixtureGit,
} from '../../../../../../apps/cli/tests/fixtures/child.js';

/** Build only private Git objects: no board, agent, claim, gate receipt or verifier identity is fabricated. */
function ancestry(t) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-policy-ancestry-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
    GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };
  /** Run the shared real-Git fixture helper with this isolated repository and identity. */
  const git = (...args) => runFixtureGit(args, { cwd: root, env }).trim();
  /** Write a private tree path, creating its parents. */
  const put = (path, text) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
  git('init', '-q', '-b', 'main');
  put('pullboard.json', JSON.stringify({ gate: 'true', lanes: { web: { owns: ['web/'], specs: ['G1'] } } }) + '\n');
  let serial = 0;
  /** Construct an explicit real commit graph; these commit-tree objects are synthetic test history only. */
  const commit = (parents, foreign = 'original coordinator bytes\n', owned = 'original owned bytes\n') => {
    put('coordinator.txt', foreign);
    put('web/owned.txt', owned);
    git('add', '-A');
    return git('commit-tree', git('write-tree'), ...parents.flatMap(parent => ['-p', parent]), '-m', `ancestry fixture ${++serial}`);
  };
  const base = commit([]);
  git('update-ref', 'refs/heads/main', base);
  return { root, git, commit, base };
}

/** A synthetic item-shaped input for the pure policy check, not a native frozen-bar or claim receipt. */
function item(claim, policy = claim) {
  return { item_lane: 'web', item_claim_head: claim, item_frozen: JSON.stringify({ policy: { commit: policy } }) };
}

test('merging authenticated main then reverting its foreign bytes cannot hide behind an older claim [L3,V4]', t => {
  const box = ancestry(t);
  const main = box.commit([box.base], 'new coordinator bytes\n');
  const branch = box.commit([box.base], undefined, 'owned change\n');
  assert.deepEqual(submissionPaths(box.root, item(main, box.base), branch, { mainCommit: main }), ['web/owned.txt'],
    'a sibling candidate did not author a reversion merely because main advanced');
  const reverted = box.commit([branch, main], undefined, 'owned change\n');
  assert.throws(() => submissionPaths(box.root, item(box.base), reverted, { mainCommit: main }),
    error => error.code === 'OUTSIDE_LANE' && error.message.includes('coordinator.txt'),
    'an actual main-merge resolution restoring old foreign bytes is an item edit');
});

test('foreign edits before the claim remain visible through frozen coordinator policy [L3,V4]', t => {
  const box = ancestry(t);
  const beforeClaim = box.commit([box.base], 'unauthorized pre-claim bytes\n');
  const candidate = box.commit([beforeClaim], 'unauthorized pre-claim bytes\n', 'owned change\n');
  assert.throws(() => submissionPaths(box.root, item(beforeClaim, box.base), candidate, { mainCommit: box.base }),
    error => error.code === 'OUTSIDE_LANE' && error.message.includes('coordinator.txt'));
});

test('missing objects and unrelated ancestry fail closed as missing policy [L3,V4]', t => {
  const box = ancestry(t);
  const orphan = box.commit([], undefined, 'unrelated owned change\n');
  assert.equal(box.git('rev-list', '--max-parents=0', orphan), orphan, 'the candidate really has an unrelated root');
  for (const [record, candidate] of [[item(box.base), orphan], [item(box.base), '0'.repeat(40)], [item('0'.repeat(40), box.base), box.base]]) {
    assert.throws(() => submissionPaths(box.root, record, candidate, { mainCommit: box.base }), { code: 'NO_POLICY' });
  }
});

test('every crisscross merge base contributes foreign paths while exact main objects remain allowed [L3,V4]', t => {
  const box = ancestry(t);
  const p = box.commit([box.base], 'first ancestor bytes\n');
  const q = box.commit([box.base], 'second ancestor bytes\n');
  const approved = 'authenticated coordinator resolution\n';
  const main = box.commit([p, q], approved);
  for (const foreign of ['first ancestor bytes\n', 'second ancestor bytes\n']) {
    const candidate = box.commit([q, p], foreign, 'owned change\n');
    assert.deepEqual(box.git('merge-base', '--all', main, candidate).split('\n').sort(), [p, q].sort());
    assert.throws(() => submissionPaths(box.root, item(main), candidate, { mainCommit: main }),
      error => error.code === 'OUTSIDE_LANE' && error.message.includes('coordinator.txt'));
  }
  const unchanged = box.commit([q, p], approved, 'owned change\n');
  assert.ok(submissionPaths(box.root, item(main), unchanged, { mainCommit: main }).includes('web/owned.txt'),
    'multiple bases do not discard an exact authenticated-main object proof');
});
