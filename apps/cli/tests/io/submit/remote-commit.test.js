/** With board.url set, a submit sends the commit it pushed and its ref, and a commit that does not descend from main is refused first [P7]. */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { carriedCommits } from '../../../src/io/submit/push-ref.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

const BODY = { verb: 'submit', item: 7, agent: 'core-9' };
const PUSHED = { url: 'http://board.invalid', token: '', commits: 'pushed' };

/** A bare trunk remote with one commit on main, a seat's clone of it, and a second clone that advances main. */
function world(t) {
  const base = privateFixtureFiles('remote-commit-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const remote = join(base, 'remote.git'), seat = join(base, 'seat'), host = join(base, 'host');
  runFixtureGit(['-C', base, 'init', '--quiet', '--bare', '-b', 'main', remote], { env });
  runFixtureGit(['clone', '--quiet', remote, host], { env });
  writeFileSync(join(host, 'a.txt'), 'one\n');
  git(host, 'add', '-A');
  git(host, 'commit', '--quiet', '-m', 'main');
  git(host, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  runFixtureGit(['clone', '--quiet', remote, seat], { env });
  const commit = (dir, file, message) => { writeFileSync(join(dir, file), `${message}\n`); git(dir, 'add', '-A'); git(dir, 'commit', '--quiet', '-m', message); return git(dir, 'rev-parse', 'HEAD'); };
  return { seat, host, git, commit };
}

test('cli.io-submit-remote-commit.a-submit-by-a-seat-with-board: clause 1: a submit by a seat with board.commits pushed sends the head it pushed and its ref, and sends nothing when the setting is off [P7]', async (t) => {
  const w = world(t);
  w.git(w.seat, 'checkout', '--quiet', '-b', 'work');
  const head = w.commit(w.seat, 'b.txt', 'pushed work');
  w.git(w.seat, 'push', '--quiet', '-u', 'origin', 'work');
  assert.deepEqual(await carriedCommits(PUSHED, BODY, w.seat), { head, ref: 'refs/heads/work' });
  assert.equal(await carriedCommits({ ...PUSHED, commits: undefined }, BODY, w.seat), undefined, 'off by default: no commits are carried');
  assert.equal(await carriedCommits(PUSHED, { ...BODY, verb: 'claim' }, w.seat), undefined, 'only a submit carries commits');
});

test('cli.io-submit-remote-commit.a-pushed-commit-that-does-not-descend: clause 2: a pushed commit that does not descend from main is refused with the next step merge main, push, resubmit [P7]', async (t) => {
  const w = world(t);
  w.git(w.seat, 'checkout', '--quiet', '-b', 'work');
  w.commit(w.seat, 'b.txt', 'pushed work on the old main');
  w.git(w.seat, 'push', '--quiet', '-u', 'origin', 'work');
  w.commit(w.host, 'c.txt', 'main moves on');
  w.git(w.host, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  w.git(w.seat, 'fetch', '--quiet', 'origin');
  w.git(w.seat, 'remote', 'set-head', 'origin', 'main');
  await assert.rejects(() => carriedCommits(PUSHED, BODY, w.seat), (error) => error.code === 'NOT_ON_MAIN' && /merge main, push, and submit again/u.test(error.message));
});

test('cli.io-submit-remote-commit.a-commit-that-is-not-pushed-is: clause 3: a commit that is not pushed is refused COMMIT_NOT_PUSHED naming the push [P7]', async (t) => {
  const w = world(t);
  w.git(w.seat, 'checkout', '--quiet', '-b', 'work');
  w.commit(w.seat, 'b.txt', 'pushed work');
  w.git(w.seat, 'push', '--quiet', '-u', 'origin', 'work');
  w.commit(w.seat, 'd.txt', 'local only');
  await assert.rejects(() => carriedCommits(PUSHED, BODY, w.seat), (error) => error.code === 'COMMIT_NOT_PUSHED' && /git push/u.test(error.message));
});
