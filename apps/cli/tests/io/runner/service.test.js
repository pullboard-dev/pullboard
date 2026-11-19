/** The installed runner entry hands serveRunner a runnerCode port only with runners.selfUpdate on, and exits 0 on a restart request [P7,#10825]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runService } from '../../../src/io/runner/service.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';

/** Run the entry with a fake serveRunner that records its options and answers as given; the board key sits in a private folder. */
async function entry(t, { port, answer, lock, onServe }) {
  const { root: dir } = privateFixtureFiles('pullboard-service-entry-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'board.key');
  writeFileSync(keyFile, 'secret\n');
  const seen = [];
  const lines = [];
  const code = await runService(['http://board.test', keyFile, join(dir, 'pull')], { serve: async options => { seen.push(options); onServe?.(); return answer; }, port, out: line => lines.push(line), ...(lock ? { lock } : {}) });
  return { code, options: seen[0], lines };
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
