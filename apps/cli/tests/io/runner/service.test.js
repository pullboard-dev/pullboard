/** The installed runner entry hands serveRunner a runnerCode port only with runners.selfUpdate on, and exits 0 on a restart request [P7,#10825]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { runService } from '../../../src/io/runner/service.js';
import { runnerCommand } from '../../../src/io/commands/runner.js';
import { privateFixtureFiles } from '../../../../../packages/gate/tests/fixtures/child.js';
import { fixtureMachineSettings } from '../../../../../packages/gate/tests/fixtures/testkit.js';

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
