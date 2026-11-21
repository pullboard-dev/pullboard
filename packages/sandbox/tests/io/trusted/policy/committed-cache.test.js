/** The committed policy's startup git reads are cached per main tip and HEAD across processes [C7]. */
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {
  delimiter,
  join,
} from 'node:path';
import {
  test,
} from 'node:test';
import {
  privateFixtureFiles,
  runFixtureGit,
} from '../../../../../gate/tests/fixtures/child.js';

/** The arguments that start each fixture repository on its own main branch. */
const REPOSITORY = ['init', '-q', '-b', 'main'];
const IDENTITY = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test Agent', GIT_AUTHOR_EMAIL: 'agent@example.com',
  GIT_COMMITTER_NAME: 'Test Agent', GIT_COMMITTER_EMAIL: 'agent@example.com' };

/** Fresh module instances, so each read starts with an empty in-process memo, as a new process does. */
let fresh = 0;

/** One private repository on main with a committed check timeout, a linked checkout, and a reader that runs behind a git spy. */
function setup(t) {
  const repo = privateFixtureFiles('policy-cache-');
  const spy = privateFixtureFiles('policy-spy-');
  t.after(() => { rmSync(repo.root, { recursive: true, force: true }); rmSync(spy.root, { recursive: true, force: true }); });
  const env = { ...process.env, ...IDENTITY };
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env }).trim();
  git(repo.root, ...REPOSITORY);
  /** Commit the policy with this check timeout in the given checkout. */
  const commitPolicy = (cwd, timeout) => {
    if (cwd === repo.root) repo.write('pullboard.json', JSON.stringify({ check: { timeout } }) + '\n');
    else writeFileSync(join(cwd, 'moved.txt'), `${timeout}\n`);
    git(cwd, 'add', '-A');
    git(cwd, 'commit', '-q', '-m', `policy ${timeout}`);
  };
  commitPolicy(repo.root, '7m');
  const linked = join(repo.root, 'linked');
  git(repo.root, 'worktree', 'add', '-q', '-b', 'item', linked);
  const real = process.env.PATH.split(delimiter).map(dir => join(dir, 'git')).find(file => existsSync(file));
  const log = join(spy.root, 'calls.log');
  spy.write('bin/git', `#!/bin/sh\necho "$*" >> '${log}'\nexec '${real}' "$@"\n`);
  chmodSync(join(spy.root, 'bin/git'), 0o755);
  spy.write('calls.log', '');
  /** Read the policy through a fresh copy of the module behind the spy: its answer and the git calls it made. */
  const read = async (root) => {
    writeFileSync(log, '');
    const saved = process.env.PATH;
    process.env.PATH = `${join(spy.root, 'bin')}${delimiter}${saved}`;
    try {
      const { mainPolicy } = await import(`../../../../src/io/trusted/policy/committed.js?fresh=${++fresh}`);
      const policy = mainPolicy(root);
      return { policy: { commit: policy.commit, timeoutMs: policy.config.check.timeoutMs }, calls: readFileSync(log, 'utf8').split('\n').filter(Boolean) };
    } finally { process.env.PATH = saved; }
  };
  return { main: repo.root, linked, commitPolicy, read };
}

test('sandbox.io-trusted-policy-committed-cache.repeat-read-no-git: clause 1: a second process at the same main tip and HEAD makes no git call and returns the same policy [C7]', async t => {
  const { main, read } = setup(t);
  const first = await read(main);
  assert.ok(first.calls.length > 0, 'the first read has to ask git');
  const second = await read(main);
  assert.deepEqual(second.calls, []);
  assert.deepEqual(second.policy, first.policy);
  assert.equal(second.policy.timeoutMs, 7 * 60_000);
});

test('sandbox.io-trusted-policy-committed-cache.tip-moves-rereads: clause 2: after main or HEAD moves the next read runs git again and returns the new policy [C7]', async t => {
  const { main, linked, commitPolicy, read } = setup(t);
  const first = await read(linked);
  assert.deepEqual((await read(linked)).calls, []);
  // HEAD moves while main stays put: the cache misses and the same policy comes back.
  commitPolicy(linked, '7m');
  const afterHead = await read(linked);
  assert.ok(afterHead.calls.length > 0, 'a HEAD move has to re-read');
  assert.deepEqual(afterHead.policy, first.policy);
  assert.deepEqual((await read(linked)).calls, []);
  // Main moves: the cache misses and the new policy comes back.
  commitPolicy(main, '9m');
  const afterMain = await read(linked);
  assert.ok(afterMain.calls.length > 0, 'a main move has to re-read');
  assert.notEqual(afterMain.policy.commit, first.policy.commit);
  assert.equal(afterMain.policy.timeoutMs, 9 * 60_000);
});
