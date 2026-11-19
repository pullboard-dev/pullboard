/** The installed runner entry hands serveRunner a runnerCode port only with runners.selfUpdate on, and exits 0 on a restart request [P7,#10825]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runService } from '../../../src/io/runner/service.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';

/** Run the entry with a fake serveRunner that records its options and answers as given; the board key sits in a private folder. */
async function entry(t, { port, answer, env = { PULLBOARD_RUNNER_JOBS: '10' } }) {
  const { root: dir } = privateFixtureFiles('pullboard-service-entry-');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const keyFile = join(dir, 'board.key');
  writeFileSync(keyFile, 'secret\n');
  const seen = [];
  const lines = [];
  const code = await runService(['http://board.test', keyFile, join(dir, 'pull')], { serve: async options => { seen.push(options); return answer; }, port, out: line => lines.push(line), env });
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
