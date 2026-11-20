/** The installed runner entry hands serveRunner a runnerCode port only with runners.selfUpdate on, and exits 0 on a restart request [P7,#10825]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { guiRunning } from '../../../src/io/runner/service.js';
import { runService } from '../../../src/io/runner/service.js';
import { runnerCommand } from '../../../src/io/commands/runner.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';

/** Run the entry with a fake serveRunner that records its options and answers as given; the board key sits in a private folder. */
async function entry(t, { port, answer, lock, onServe, env = { PULLBOARD_RUNNER_JOBS: '10' } }) {
  const { root: dir } = privateFixtureFiles('pullboard-service-entry-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'board.key');
  writeFileSync(keyFile, 'secret\n');
  const seen = [];
  const lines = [];
  const code = await runService(['http://board.test', keyFile, join(dir, 'pull')], { serve: async options => { seen.push(options); onServe?.(); return answer; }, port, out: line => lines.push(line), env, ...(lock ? { lock } : {}) });
  return { code, options: seen[0], lines, served: seen.length };
}

test('cli.io-runner-service.self-update-on-passes-the-port-and-exits-0: clause 1: with runners.selfUpdate on, the entry passes serveRunner the runnerCode port for its own install folder and exits 0 when serveRunner returns asking for a restart [C7,#10825]', async t => {
  const port = { changed: async () => true, refresh: async () => true };
  const asked = [];
  const { code, options, lines } = await entry(t, { port: async cache => { asked.push(cache); return port; }, answer: { restart: 'c2' } });
  assert.equal(options.runnerCode, port);
  assert.equal(asked.length, 1);
  assert.match(asked[0], /pull$/u, 'the port is built for the pull cache');
  assert.equal(code, 0);
  assert.ok(lines.some(line => line.includes('runner code changed to c2')), lines.join(''));
});

test('cli.io-runner-service.self-update-off-passes-no-port: clause 2: with runners.selfUpdate off, the entry passes no runnerCode port and serves as today [C7,#10825]', async t => {
  const { code, options } = await entry(t, { port: async () => null, answer: { jobs: [] } });
  assert.equal('runnerCode' in options, false);
  assert.equal(code, 0);
});

test('cli.io-runner-service.lock-held-exits-1-without-serving: clause 3: runService takes the cache lock before it calls serve, and with the lock held returns exit 1 with the RUNNER_ALREADY_RUNNING line and never calls serve [P7]', async t => {
  const order = [];
  const taken = [];
  const lock = cache => { order.push('lock'); taken.push(cache); return { release: () => order.push('release') }; };
  const free = await entry(t, { port: async () => null, answer: { jobs: [] }, lock, onServe: () => order.push('serve') });
  assert.equal(free.code, 0);
  assert.deepEqual(order, ['lock', 'serve', 'release']);
  assert.match(taken[0], /pull$/u, 'the lock is taken on the cache folder');
  const held = await entry(t, { port: async () => null, answer: { jobs: [] }, onServe: () => order.push('served-held'),
    lock: () => { throw Object.assign(new Error('another runner service holds serve.lock: pid 9'), { code: 'RUNNER_ALREADY_RUNNING' }); } });
  assert.equal(held.code, 1);
  assert.equal(held.options, undefined, 'serve was not called');
  assert.ok(held.lines.some(line => line.includes('stopped: RUNNER_ALREADY_RUNNING')), held.lines.join(''));
  assert.equal(order.includes('served-held'), false);
});

test('cli.io-runner-service.without-runner-jobs-refuses-to-serve: clause 1: with PULLBOARD_RUNNER_JOBS missing from the environment, the entry returns 1, never calls serve, and says a line naming PULLBOARD_RUNNER_JOBS and pullboard runner install-serve [C7]', async t => {
  for (const env of [{}, { PULLBOARD_RUNNER_JOBS: '' }]) {
    const { code, served, lines } = await entry(t, { port: async () => null, answer: { jobs: [] }, env });
    assert.equal(code, 1);
    assert.equal(served, 0, 'serve is never called');
    assert.ok(lines.some(line => line.includes('PULLBOARD_RUNNER_JOBS') && line.includes('pullboard runner install-serve')), lines.join(''));
  }
});

test('cli.io-runner-service.with-runner-jobs-set-serves-and-exits-0: clause 2: with PULLBOARD_RUNNER_JOBS set to 10, the entry calls serve and returns 0, the path the installed launchd service takes [C7]', async t => {
  const { code, served } = await entry(t, { port: async () => null, answer: { jobs: [] }, env: { PULLBOARD_RUNNER_JOBS: '10' } });
  assert.equal(code, 0);
  assert.equal(served, 1);
});

/** Run work with PULLBOARD_MACHINE_HOME on a folder whose settings.json holds the given document (or none), then restore the variable. */
async function withSettings(t, document, work) {
  const { root: home } = privateFixtureFiles('pullboard-service-settings-');
  t.after(() => rmSync(home, { recursive: true, force: true }));
  if (document !== undefined) fixtureMachineSettings(home, document);
  const before = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = home;
  try { return await work(); } finally { if (before === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = before; }
}

test('cli.io-runner-service.passes-the-job-worker-factor: clause 1: runService passes serveRunner jobWorkerFactor from runners.jobWorkerFactor in the machine settings file, 2 when it is unset [C7,#11838]', async t => {
  for (const [document, want] of [[{ 'runners.jobWorkerFactor': 3 }, 3], [{}, 2], [undefined, 2]]) {
    const { options } = await withSettings(t, document, () => entry(t, { port: async () => null, answer: { jobs: [] } }));
    assert.equal(options.jobWorkerFactor, want, JSON.stringify(document));
  }
});

test('cli.io-runner-service.command-passes-the-job-worker-factor: clause 2: pullboard runner serve passes serveRunner the same jobWorkerFactor from the machine settings file [C7,#11838]', async t => {
  for (const [document, want] of [[{ 'runners.jobWorkerFactor': 4 }, 4], [{}, 2]]) {
    const seen = [];
    await withSettings(t, document, () => runnerCommand({ say: () => {}, result: () => {} }, { first: 'serve', second: 'http://board.test', rest: [], values: { once: true } }, { serve: async options => { seen.push(options); return { jobs: [] }; } }));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].jobWorkerFactor, want, JSON.stringify(document));
  }
});

test('cli.io-runner-service.peer-port-on: clause 1: runService with machine setting runners.oneServePerHost on passes serve a peer { session, guiRunning }, session being gui when env PULLBOARD_RUNNER_SESSION is gui and daemon otherwise, and with the setting off the serve call carries no peer key [C7,P7]', async t => {
  for (const [session, want] of [['gui', 'gui'], [undefined, 'daemon'], ['other', 'daemon']]) {
    const env = { PULLBOARD_RUNNER_JOBS: '10', ...(session ? { PULLBOARD_RUNNER_SESSION: session } : {}) };
    const { options } = await withSettings(t, { 'runners.oneServePerHost': true }, () => entry(t, { port: async () => null, answer: { jobs: [] }, env }));
    assert.equal(options.peer.session, want, String(session));
    assert.equal(typeof options.peer.guiRunning, 'function');
  }
  for (const document of [{ 'runners.oneServePerHost': false }, {}, undefined]) {
    const { options } = await withSettings(t, document, () => entry(t, { port: async () => null, answer: { jobs: [] } }));
    assert.equal(Object.hasOwn(options, 'peer'), false, JSON.stringify(document));
  }
});

test('cli.io-runner-service.gui-running-probe: clause 2: guiRunning, given an injected exec, returns true only when launchctl print gui/<uid>/dev.pullboard.runner-serve exits 0 and prints state = running, and returns false on a nonzero exit or a thrown error [C7,P7]', () => {
  const asked = [];
  const exec = reply => (file, args) => { asked.push([file, ...args]); if (reply instanceof Error) throw reply; return reply; };
  assert.equal(guiRunning({ uid: 501, exec: exec({ status: 0, stdout: '\tstate = running\n' }) }), true);
  assert.deepEqual(asked[0], ['launchctl', 'print', 'gui/501/dev.pullboard.runner-serve']);
  assert.equal(guiRunning({ uid: 501, exec: exec({ status: 0, stdout: '\tstate = waiting\n' }) }), false);
  assert.equal(guiRunning({ uid: 501, exec: exec({ status: 113, stdout: 'state = running' }) }), false);
  assert.equal(guiRunning({ uid: 501, exec: exec(new Error('spawn launchctl ENOENT')) }), false);
});
