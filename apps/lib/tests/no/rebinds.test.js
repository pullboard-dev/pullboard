/** A board opened without its repository rebinds itself from its file's location and seals the submit, instead of a NO_POLICY red [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  closeBoard,
  openBoard,
} from '../../index.js';
import { repositoryOfBoardFile } from '../../../../packages/store/index.js';
import { sealClauseInspection } from '../../../../packages/store/index.js';
import { runFixtureGit } from '../../../cli/tests/fixtures/child.js';

test('an absent binding is refreshed from the board file and the submit seals once, with no NO_POLICY [C7]', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-rebind-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  const git = (...args) => runFixtureGit(args, { cwd: root, env });
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), '{}\n');
  git('add', '-A'); git('commit', '-qm', 'chore: policy');
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  // @pullboard-board-file persistence: the binding refresh reads this board by its repository file path
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  t.after(() => closeBoard(board));
  assert.equal(board.gitRoot, undefined, 'the board was opened without its repository');
  const options = { agentId: 'fixture', commit: 'a'.repeat(40), tree: 'b'.repeat(40) };
  const sealed = sealClauseInspection(board, 1, options);
  assert.equal(board.gitRoot, root, 'the board rebound itself to its repository');
  assert.equal(sealed.clausePolicyCommit, git('rev-parse', 'HEAD'));
  assert.deepEqual(sealClauseInspection(board, 1, options), sealed, 'a second seal on the rebound board gives the same answer');
});

test('a board file outside a repository still refuses with NO_POLICY, naming the next step [C7]', t => {
  const directory = mkdtempSync(join(tmpdir(), 'pullboard-no-repository-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  // @pullboard-board-file persistence: the refusal under test reads a board file outside any repository
  const board = openBoard(join(directory, 'board.sqlite'));
  t.after(() => closeBoard(board));
  assert.equal(repositoryOfBoardFile(join(directory, 'board.sqlite')), null);
  assert.throws(() => sealClauseInspection(board, 1, { agentId: 'fixture' }), { code: 'NO_POLICY', message: /must know its repository/u });
});


/** Open an actual file-backed board and count delegated canonical policy reads without replacing their results. */
function policyFixture(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-stale-policy-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo');
  mkdirSync(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' };
  /** Run Git only in the named real private repository. */
  const gitAt = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  /** Run Git in the board's repository. */
  const git = (...args) => gitAt(root, ...args);
  git('init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), '{}\n');
  git('add', '-A'); git('commit', '-qm', 'chore: policy [C7]');
  mkdirSync(join(root, '.git/pullboard'), { recursive: true });
  // @pullboard-board-file persistence: the policy refusal reads this repository board by its file path
  const board = openBoard(join(root, '.git/pullboard/board.sqlite'));
  t.after(() => closeBoard(board));
  const reads = [];
  const canonical = board.enginePorts.sandboxPolicyReads;
  board.enginePorts = { ...board.enginePorts, sandboxPolicyReads: { ...canonical,
    /** Observe the root and retain the actual committed-policy read and its real refusal. */
    mainPolicy(root) { reads.push(root); return canonical.mainPolicy(root); },
  } };
  return { dir, root, board, reads, git, gitAt };
}

test('a nonempty stale repository binding retries the real policy refusal exactly once [C7]', t => {
  const box = policyFixture(t);
  const stale = join(box.dir, 'stale');
  mkdirSync(stale);
  box.gitAt(stale, 'init', '-q', '-b', 'main');
  writeFileSync(join(stale, 'README.md'), 'This old repository has no committed board policy.\n');
  box.gitAt(stale, 'add', '-A'); box.gitAt(stale, 'commit', '-qm', 'chore: old checkout [C7]');
  box.board.gitRoot = stale;
  const options = { policyCommit: box.git('rev-parse', 'HEAD') };
  const sealed = sealClauseInspection(box.board, 1, options);
  assert.deepEqual(box.reads, [stale, box.root], 'the real NO_POLICY read is retried once against board-file custody');
  assert.equal(box.board.gitRoot, box.root);
  assert.equal(sealed.clausePolicyCommit, options.policyCommit);
  assert.equal(Object.hasOwn(options, 'clausePolicyCommit'), false, 'recovery does not mutate the request');
  assert.deepEqual(sealClauseInspection(box.board, 1, options), sealed);
  assert.deepEqual(box.reads, [stale, box.root, box.root], 'a refreshed healthy binding needs one read');
});

test('a genuine accepted policy change still refuses after exactly one binding retry [C7]', t => {
  const box = policyFixture(t);
  box.board.gitRoot = box.root;
  const policyCommit = box.git('rev-parse', 'HEAD');
  writeFileSync(join(box.root, 'pullboard.json'), '{"gate":"false"}\n');
  box.git('add', '-A'); box.git('commit', '-qm', 'chore: change accepted gate [C7]');
  assert.throws(() => sealClauseInspection(box.board, 1, { policyCommit }),
    { code: 'NO_POLICY', message: /accepted submit policy changed:.*gate/u });
  assert.deepEqual(box.reads, [box.root, box.root], 'the second genuine refusal propagates without a loop');
  assert.equal(box.board.gitRoot, box.root);
});

test('a non-policy configuration refusal is propagated without a repository retry [C7]', t => {
  const box = policyFixture(t);
  box.board.gitRoot = box.root;
  writeFileSync(join(box.root, 'pullboard.json'), '{"gate":17}\n');
  box.git('add', '-A'); box.git('commit', '-qm', 'chore: invalid accepted gate [C7]');
  assert.throws(() => sealClauseInspection(box.board, 1, {}), { code: 'BAD_CONFIG' });
  assert.deepEqual(box.reads, [box.root], 'only NO_POLICY permits recovery');
});
