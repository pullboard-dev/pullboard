/** A runner screens a sprint item's commit on its base and records one green or red screen receipt [V16,M1]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { test } from 'node:test';
import { fixtureBoard } from '../../../board/tests/fixtures/board.js';
import { fixtureCommittedGraph } from '../../../gate/tests/fixtures/testkit.js';
import { runFixtureSetupGit } from '../../../gate/tests/fixtures/child.js';
import { runScreenJob } from '../../index.js';

const IDENTITY = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
  GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };

/**
 * A real repo whose main has one base commit. `onItem` commits on an item branch cut from that base, `onMain` moves main
 * on, so the item's commit and the current base are two real commits.
 */
function fixture(t) {
  const graph = fixtureCommittedGraph('pullboard-screen-');
  t.after(() => rmSync(graph.root, { recursive: true, force: true }));
  const git = (...args) => String(runFixtureSetupGit(args, { cwd: graph.root, env: { ...process.env, ...IDENTITY } })).trim();
  graph.put('readme.txt', 'base\n');
  graph.commit();
  git('branch', 'item');
  const on = (branch) => (path, body, message) => {
    git('checkout', '-q', branch);
    graph.put(path, body);
    git('add', '-A');
    git('commit', '-qm', message);
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '-q', 'main');
    return sha;
  };
  return { root: graph.root, onItem: on('item'), onMain: on('main') };
}

/**
 * The re-check port, in the shape of the commits cell's recheckRange (proved on real secrets in its own test, #8866):
 * it reads base..head from git and names each commit whose added lines assign an apiKey. Why a port: the drive cell may
 * not import the commits cell, so the host hands the trusted re-check in, and this test checks the range it is given.
 */
function recheck(repo, base, head) {
  const git = (...args) => String(runFixtureSetupGit(args, { cwd: repo, env: { ...process.env, ...IDENTITY } })).trim();
  return git('rev-list', '--reverse', `${base}..${head}`).split('\n').filter(Boolean)
    .filter(commit => /^\+.*apiKey = '/mu.test(git('show', '--format=', commit)))
    .map(commit => ({ commit, kind: 'secret', problem: 'assigned secret at config.js:1; remove it and rotate the key' }));
}

/** Screen one item through the drive's keyed job. */
function screen(t, repo, commit, base, { pace = 'sprint', staticCommand = null } = {}) {
  const board = fixtureBoard(t);
  const item = { id: 7, pace, commit, digest: 'd1' };
  return runScreenJob(board.db, { repo, item, base, owner: 'runner-1', recheck, staticCommand }).then(ran => ({ ran, board, item }));
}

test('clause 1: a sprint item whose commit merges cleanly on its base with no re-check findings records a green screen receipt at that commit and base [V16]', async t => {
  const repo = fixture(t);
  const commit = repo.onItem('notes.txt', 'hello\n', 'docs(notes): add notes');
  const base = repo.onMain('other.txt', 'other\n', 'docs(other): add other');
  // The static checks run in the merged tree and are told the changed files.
  const staticCommand = 'test -f other.txt && test -f notes.txt && test "$PULLBOARD_CHANGED_FILES" = notes.txt';
  const { ran, board, item } = await screen(t, repo.root, commit, base, { staticCommand });
  assert.equal(ran.state, 'produced');
  assert.deepEqual(ran.result,
    { kind: 'screen', item: 7, commit, digest: 'd1', base, green: true, trusted: true, leased: true,
      checks: { merge: 'green', static: 'green', secrets: 'green', hooks: 'green' }, findings: [] });
  const again = await runScreenJob(board.db, { repo: repo.root, item, base, owner: 'runner-2', recheck: () => { throw new Error('screened twice'); } });
  assert.deepEqual([again.state, again.result], ['stored', ran.result], 'one receipt per commit, digest and base');
  const steady = await runScreenJob(board.db, { repo: repo.root, item: { ...item, pace: 'steady' }, base, owner: 'runner-1', recheck });
  assert.deepEqual(steady, { state: 'skipped' }, 'a steady item is never screened');
  assert.deepEqual(board.db.prepare('SELECT job_kind FROM job').all().map(row => row.job_kind), ['screen']);
});

test('clause 2: a commit carrying a secret records a red screen receipt naming the finding [V16,C1]', async t => {
  const repo = fixture(t);
  // Built from parts so this file never holds a secret-shaped line itself.
  const value = ['abcd', 'efgh', 'ijkl', 'mnop', 'qrst'].join('');
  const commit = repo.onItem('config.js', `export const apiKey = '${value}';\n`, 'fix(config): add a key');
  const base = repo.onMain('other.txt', 'other\n', 'docs(other): add other');
  const { ran } = await screen(t, repo.root, commit, base);
  assert.equal(ran.result.green, false);
  assert.deepEqual(ran.result.checks, { merge: 'green', static: 'green', secrets: 'red', hooks: 'green' });
  assert.equal(ran.result.findings.length, 1);
  assert.match(ran.result.findings[0], /^secrets: [0-9a-f]{12} .*assigned secret at config\.js:1/u);
  assert.ok(!ran.result.findings[0].includes(value), 'the value is never echoed');
});

test('clause 3: a commit that conflicts with its base records a red screen receipt naming the conflict [V16]', async t => {
  const repo = fixture(t);
  const commit = repo.onItem('readme.txt', 'item\n', 'docs(readme): item words');
  const base = repo.onMain('readme.txt', 'main\n', 'docs(readme): main words');
  const { ran } = await screen(t, repo.root, commit, base, { staticCommand: 'exit 1' });
  assert.equal(ran.result.green, false);
  assert.deepEqual(ran.result.checks, { merge: 'red', static: 'not-run', secrets: 'not-run', hooks: 'not-run' });
  assert.deepEqual(ran.result.findings, [`merge: conflict with ${base} in readme.txt`]);
});
