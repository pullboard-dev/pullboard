/** A pulled job runs with its own machine home, so its test run never reads or takes the host's runner pools (#8361) [C7]. */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { relative } from 'node:path';
import { test } from 'node:test';
import { jobEnvironment } from '../../../src/io/pull.js';
import { requestedJobEnvironment } from '../../../src/io/pull.js';
import { serveRunner } from '../../../index.js';
import { runTestGit } from '../../fixtures/git.js';
import { testGit } from '../../fixtures/git.js';
import { temporaryDirectory } from '../../../../board/tests/fixtures/board.js';

/** A throwaway runner cache folder, removed when the test ends. */
function cacheFolder(t) {
  const cache = temporaryDirectory('pullboard-job-machine-');
  t.after(() => rmSync(cache, { recursive: true, force: true }));
  return cache;
}

/** Whether `path` lies inside `folder`. */
function inside(folder, path) {
  const rest = relative(folder, path);
  return rest !== '' && !rest.startsWith('..');
}

test('drive.machine-home.a-test-process-in-a: clause 1: a test process in a pulled job gets a machine pool inside its own job folder, never the host\'s runner pools [C7]', t => {
  const cache = cacheFolder(t);
  const real = join(cache, 'real-account', '.pullboard');
  const host = { PATH: '/usr/bin:/bin', HOME: join(cache, 'real-account'), PULLBOARD_MACHINE_HOME: real, PULLBOARD_ACCOUNT_HOME: join(cache, 'real-account') };
  const { env, folder } = jobEnvironment(cache, 'gate-1', 'gate:1:shard:1', host);
  assert.ok(env.PULLBOARD_MACHINE_HOME, 'the job names its machine home');
  assert.notEqual(env.PULLBOARD_MACHINE_HOME, real, 'the host\'s machine home, where its runners are registered, is not passed down');
  assert.ok(inside(folder, env.PULLBOARD_MACHINE_HOME), `${env.PULLBOARD_MACHINE_HOME} is inside the job folder ${folder}`);
  assert.equal(env.PULLBOARD_ACCOUNT_HOME, undefined, 'the host account home is not passed down either');
});

test('drive.machine-home.a-pulled-gate-shard-on: clause 2: a pulled gate shard on a runner whose service has no machine home still runs on its own pool, not the account\'s ~/.pullboard [C7]', t => {
  // 15 Nov: the local runner's service carried only PULLBOARD_ACCOUNT_HOME; its job had neither, read the OS account's
  // ~/.pullboard, and fanned its 10 files out onto the real runners' pools for 37 min.
  const cache = cacheFolder(t);
  const { env, folder } = jobEnvironment(cache, 'gate-8217-shard-16', 'gate:8217:shard:16', { PATH: '/usr/bin:/bin' });
  assert.equal(env.PULLBOARD_MACHINE_HOME, join(env.HOME, '.pullboard'), 'the job\'s machine home sits in the job\'s own HOME');
  assert.ok(inside(folder, env.PULLBOARD_MACHINE_HOME));
});

test('drive.machine-home.temp-root-on-named-folder: clause 1: a host naming an existing folder in PULLBOARD_RUNNER_TMP_ROOT gets the job TMPDIR inside it, created empty, never passed on [test] [C7]', t => {
  const cache = cacheFolder(t), root = join(cache, 'ramdisk');
  mkdirSync(root);
  const host = { PATH: '/usr/bin:/bin', PULLBOARD_RUNNER_TMP_ROOT: root };
  const { env, temporary } = jobEnvironment(cache, 'gate-9', 'gate:9:shard:1', host);
  assert.equal(env.TMPDIR, join(root, 'gate-9'), 'TMPDIR is the named folder joined with the job name');
  assert.equal(temporary, env.TMPDIR, 'temporary is the same path, for the reap');
  assert.ok(existsSync(temporary), 'the folder is made');
  assert.equal(env.PULLBOARD_RUNNER_TMP_ROOT, undefined, 'the variable is not handed to the job');
});

test('drive.machine-home.playwright-path-passed: clause 1: a host PLAYWRIGHT_BROWSERS_PATH reaches the job environment unchanged [test] [C7]', t => {
  const cache = cacheFolder(t);
  const { env } = jobEnvironment(cache, 'gate-11', 'gate:11:shard:1', { PATH: '/usr/bin:/bin', PLAYWRIGHT_BROWSERS_PATH: '/opt/browsers' });
  assert.equal(env.PLAYWRIGHT_BROWSERS_PATH, '/opt/browsers');
});

test('drive.machine-home.playwright-default-cache: clause 2: with no host value the job gets the host default browser cache folder when it exists, and none when it does not [test] [C7]', t => {
  const cache = cacheFolder(t), hostHome = join(cache, 'hosthome'), browsers = join(hostHome, '.cache/ms-playwright');
  const host = { PATH: '/usr/bin:/bin', HOME: hostHome };
  assert.equal(jobEnvironment(cache, 'gate-12', 'gate:12:shard:1', host).env.PLAYWRIGHT_BROWSERS_PATH, undefined, 'no folder, no variable');
  mkdirSync(browsers, { recursive: true });
  assert.equal(jobEnvironment(cache, 'gate-13', 'gate:13:shard:1', host).env.PLAYWRIGHT_BROWSERS_PATH, browsers);
  assert.equal(jobEnvironment(cache, 'gate-14', 'gate:14:shard:1', { ...host, PLAYWRIGHT_BROWSERS_PATH: '/opt/b' }).env.PLAYWRIGHT_BROWSERS_PATH, '/opt/b', 'a host value wins over the default');
});

test('drive.machine-home.temp-root-unset-or-missing: clause 2: with PULLBOARD_RUNNER_TMP_ROOT unset, missing or a file, TMPDIR stays the cache env folder tmp [test] [C7]', t => {
  const cache = cacheFolder(t), file = join(cache, 'afile');
  writeFileSync(file, 'x');
  for (const root of [undefined, join(cache, 'nowhere'), file]) {
    const { env, folder, temporary } = jobEnvironment(cache, 'gate-10', 'gate:10:shard:1', { PATH: '/usr/bin:/bin', PULLBOARD_RUNNER_TMP_ROOT: root });
    assert.equal(env.TMPDIR, join(folder, 'tmp'), `root ${root}: TMPDIR stays under the cache`);
    assert.equal(temporary, env.TMPDIR);
  }
});

test('drive.machine-home.a-request-s-fixture-variable: clause 1: a job request\'s fixture variable is set in the job over the runner service\'s value, and a request with no env map adds nothing [test] [C7,#10848]', t => {
  const cache = cacheFolder(t);
  const host = { PATH: '/usr/bin:/bin', PULLBOARD_FIXTURE_INPROCESS_HOOKS: '0', FIXTURE_HOST_ONLY: 'kept' };
  const { env } = jobEnvironment(cache, 'test-1', 'test:1:a', host, { PULLBOARD_FIXTURE_INPROCESS_HOOKS: '1', FIXTURE_FROM_REQUEST: 'yes' });
  assert.equal(env.PULLBOARD_FIXTURE_INPROCESS_HOOKS, '1', 'the request\'s value wins over the runner service\'s');
  assert.equal(env.FIXTURE_FROM_REQUEST, 'yes');
  assert.equal(env.FIXTURE_HOST_ONLY, 'kept', 'the passed host names still reach the job');
  const plain = jobEnvironment(cache, 'test-2', 'test:2:a', host).env;
  const none = jobEnvironment(cache, 'test-3', 'test:3:a', host, null).env;
  assert.equal(plain.FIXTURE_FROM_REQUEST, undefined, 'no env map sets nothing');
  assert.deepEqual(Object.keys(none).filter(key => /FIXTURE/u.test(key)).sort(), ['FIXTURE_HOST_ONLY', 'PULLBOARD_FIXTURE_INPROCESS_HOOKS']);
  assert.equal(none.PULLBOARD_FIXTURE_INPROCESS_HOOKS, '0', 'without a request the host value stands');
});

test('drive.machine-home.a-request-naming-any-other: clause 2: a request naming any other variable, or a non-string value, is refused JOB_ENV_REFUSED naming it [test] [C7,#10848]', () => {
  for (const name of ['PATH', 'HOME', 'NODE_OPTIONS', 'PULLBOARD_MACHINE_HOME', 'fixture_lower']) {
    assert.throws(() => requestedJobEnvironment({ [name]: 'x' }), error => error.code === 'JOB_ENV_REFUSED' && error.message.includes(name), `${name} is refused by name`);
  }
  for (const value of [1, null, ['1'], 'x'.repeat(1025), 'a\0b']) {
    assert.throws(() => requestedJobEnvironment({ PULLBOARD_FIXTURE_X: value }), error => error.code === 'JOB_ENV_REFUSED' && error.message.includes('PULLBOARD_FIXTURE_X'));
  }
  assert.throws(() => requestedJobEnvironment(['PULLBOARD_FIXTURE_X=1']), error => error.code === 'JOB_ENV_REFUSED');
  assert.throws(() => requestedJobEnvironment('PULLBOARD_FIXTURE_X=1'), error => error.code === 'JOB_ENV_REFUSED');
  assert.deepEqual(requestedJobEnvironment(undefined), {});
  assert.deepEqual(requestedJobEnvironment({ PULLBOARD_FIXTURE_X: '1', FIXTURE_Y: '' }), { PULLBOARD_FIXTURE_X: '1', FIXTURE_Y: '' });
});

/** A trunk whose main holds one commit, and an empty runner cache folder. */
async function trunkWithMain(t) {
  const trunk = temporaryDirectory('pullboard-jobenv-trunk-');
  const cache = temporaryDirectory('pullboard-jobenv-cache-');
  t.after(() => { rmSync(trunk, { recursive: true, force: true }); rmSync(cache, { recursive: true, force: true }); });
  const sh = async (...args) => (await runTestGit(trunk, ['-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', ...args])).stdout;
  await sh('init', '-q', '-b', 'main');
  writeFileSync(join(trunk, 'tracked.txt'), 'one\n');
  await sh('add', '.');
  await sh('commit', '-q', '-m', 'one');
  return { trunk, cache, main: await sh('rev-parse', 'HEAD') };
}

/** Serve one claimed job whose request carries `env` through serveRunner against a fake board; returns its receipts and releases. */
async function serveOne(t, env) {
  const { trunk, cache, main } = await trunkWithMain(t);
  const receipts = [], releases = [];
  let claimed = false;
  const reply = document => ({ status: 200, json: async () => document });
  const script = `console.log('SEEN '+process.env.PULLBOARD_FIXTURE_PG10+' '+String(process.env.PATH_SHADOW))`;
  const fetchImpl = async (_url, { body }) => {
    const call = JSON.parse(body);
    if (call.action === 'claim') {
      const first = !claimed;
      claimed = true;
      return reply({ trunk, claim: first ? { job: 'test:10848:env', attempt: 1, token: 't-1', candidate: main, base: main } : null });
    }
    if (call.action === 'request') return reply({ request: { run: ['node', '-e', script], commits: [main], input: { main, entry: 'x', data: { main, source: main } }, env } });
    if (call.action === 'receipt') receipts.push(call.receipt);
    if (call.action === 'release') releases.push(call.reason);
    return reply({ ok: true, renewed: true });
  };
  const stop = new AbortController();
  await serveRunner({ git: testGit, board: 'http://board.invalid/api/v1/boards/b?k=x', runner: 'r-jobenv', capabilities: [], cache, jobs: 1, signal: stop.signal, fetchImpl,
    sleep: async () => { stop.abort(); }, timing: { idleMs: 1 } });
  return { receipts, releases };
}

test('drive.machine-home.a-served-job-runs-with: clause 3: a served job runs with its request\'s fixture variable set, and a request naming another variable goes back JOB_ENV_REFUSED unrun [test] [C7,#10848]', { timeout: 60_000 }, async t => {
  const ran = await serveOne(t, { PULLBOARD_FIXTURE_PG10: 'on' });
  assert.equal(ran.receipts.length, 1, JSON.stringify(ran));
  assert.match(ran.receipts[0].gate.error, /SEEN on undefined/u, 'the job saw the request\'s variable through runHeld and jobEnvironment');
  const refused = await serveOne(t, { PULLBOARD_FIXTURE_PG10: 'on', PATH_SHADOW: '/tmp/evil' });
  assert.equal(refused.receipts.length, 0, 'a refused request never runs');
  assert.equal(refused.releases.length, 1, JSON.stringify(refused));
  assert.match(refused.releases[0], /^\[JOB_ENV_REFUSED\] .*PATH_SHADOW/u);
});
