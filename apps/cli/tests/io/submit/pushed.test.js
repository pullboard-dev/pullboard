/** A board host gates a commit a remote seat already pushed to trunk.remote, not its own checkout HEAD [P7]. */
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { receivePushed } from '../../../src/io/submit/pushed.js';
import { privateFixtureFiles } from '../../fixtures/child.js';
import { runFixtureGit } from '../../fixtures/child.js';

const SEAT = { remoteAgent: 'core-9' };
const BODY = (commits) => ({ verb: 'submit', item: 7, agent: 'core-9', commits });
const claimed = { item_status: 'claimed', item_owner: 'core-9' };

/** A bare trunk remote, the board host's clone of it, and a seat's clone with one commit on top of main. */
function world(t) {
  const base = privateFixtureFiles('pushed-').root;
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const key of Object.keys(env)) if (key.startsWith('GIT_') && !key.startsWith('GIT_CONFIG_') && !key.startsWith('GIT_AUTHOR') && !key.startsWith('GIT_COMMITTER')) delete env[key];
  const git = (cwd, ...args) => runFixtureGit(args, { cwd, env });
  const remote = join(base, 'remote.git'), host = join(base, 'host'), seat = join(base, 'seat');
  runFixtureGit(['-C', base, 'init', '--quiet', '--bare', '-b', 'main', remote], { env });
  runFixtureGit(['clone', '--quiet', remote, host], { env });
  writeFileSync(join(host, 'a.txt'), 'one\n');
  git(host, 'add', '-A');
  git(host, 'commit', '--quiet', '-m', 'main');
  git(host, 'push', '--quiet', 'origin', 'HEAD:refs/heads/main');
  runFixtureGit(['clone', '--quiet', remote, seat], { env });
  const commit = (message) => { writeFileSync(join(seat, 'a.txt'), `${message}\n`); git(seat, 'commit', '--quiet', '-am', message); return git(seat, 'rev-parse', 'HEAD'); };
  return { remote, host, seat, git, commit };
}

const receive = (w, commits) => receivePushed(w.host, BODY(commits), SEAT, (read) => read({}), () => claimed, { remote: w.remote });

test('clause 1: a submit that carries a commit and ref gates that commit when it is reachable on the ref at trunk.remote [P7]', (t) => {
  const w = world(t);
  const head = w.commit('pushed work');
  w.git(w.seat, 'push', '--quiet', 'origin', 'HEAD:refs/heads/work');
  const folder = receive(w, { head, ref: 'refs/heads/work' });
  assert.equal(w.git(folder, 'rev-parse', 'HEAD'), head, 'the host folder sits at the pushed commit, not the host checkout HEAD');
  assert.notEqual(w.git(w.host, 'rev-parse', 'HEAD'), head);
  assert.equal(w.git(w.host, 'rev-parse', 'refs/pullboard/remote/core-9/item-7'), head);
});

test('clause 2: a commit missing from the remote is refused REMOTE_COMMIT_MISSING with a next step [P7]', (t) => {
  const w = world(t);
  const head = w.commit('never pushed');
  assert.throws(() => receive(w, { head, ref: 'refs/heads/work' }), (error) => error.code === 'REMOTE_COMMIT_MISSING' && /push/u.test(error.message));
});

test('clause 3: a ref that does not point at that commit is refused REMOTE_REF_MISMATCH with a next step [P7]', (t) => {
  const w = world(t);
  const pushed = w.commit('pushed work');
  w.git(w.seat, 'push', '--quiet', 'origin', 'HEAD:refs/heads/work');
  const head = w.commit('later work, not pushed');
  assert.notEqual(head, pushed);
  assert.throws(() => receive(w, { head, ref: 'refs/heads/work' }), (error) => error.code === 'REMOTE_REF_MISMATCH' && /push/u.test(error.message));
});
