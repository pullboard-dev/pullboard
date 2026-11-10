/** A runner job reports its result before cleanup; a slow cleanup runs on in the background and never delays the gate [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { watch } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runFixtureChild } from '../../../../../../apps/cli/tests/fixtures/child.js';
import { HOST } from '../../../../../../apps/cli/tests/fixtures/runner/ssh.js';
import { installSshStandIn } from '../../../../../../apps/cli/tests/fixtures/runner/ssh.js';

const SLOW_CLEANUP_MS = 5_000;

/** Run one git command in the fixture repository. */
function git(root, env, ...args) {
  const result = runFixtureChild('git', args, { cwd: root, env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.context);
}

test('a job whose cleanup sleeps reports its result at once and its cleanup still finishes [C7]', { timeout: 60_000 }, async t => { // budget: real worker protocol plus the fixture's slow cleanup.
  const dir = mkdtempSync(join(tmpdir(), 'pb-bg-cleanup-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'repo'), bin = join(dir, 'bin'), worker = join(dir, 'worker'), home = join(dir, 'home');
  const remoteHome = join(dir, 'remote-home'), remoteMachineHome = join(remoteHome, '.pullboard');
  for (const folder of [root, bin, worker, home, join(home, '.pullboard'), remoteHome, remoteMachineHome]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(bin, 'package.json'), JSON.stringify({ type: 'module' }));
  // The worker's final job-directory removal blocks for SLOW_CLEANUP_MS, as a slow disk or a stuck unlink would.
  const slow = join(dir, 'slow-cleanup.mjs');
  writeFileSync(slow, `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { dirname } from 'node:path';
const real = fs.rmSync;
fs.rmSync = (path, options) => {
  if (dirname(String(path)).endsWith('/jobs')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${SLOW_CLEANUP_MS});
  return real(path, options);
};
syncBuiltinESMExports();
`);
  installSshStandIn({ bin, worker, home: remoteHome, machineHome: remoteMachineHome, requests: join(dir, 'requests.jsonl'),
    nodeOptions: `--import=${pathToFileURL(slow).href}` });
  const env = { ...process.env, HOME: home, PULLBOARD_HOME: home, PULLBOARD_MACHINE_HOME: join(home, '.pullboard'), PATH: `${bin}:${process.env.PATH}`,
    GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' };
  for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_CONFIG_PARAMETERS']) delete env[name];
  git(root, env, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ gate: 'true' }));
  git(root, env, 'add', '.'); git(root, env, 'commit', '-qm', 'test: cleanup fixture');
  const runner = pathToFileURL(new URL('../../../../../runners/index.js', import.meta.url).pathname).href;
  const script = `import { runOnRunnerAsync } from ${JSON.stringify(runner)};
const started = Date.now();
try { const run = await runOnRunnerAsync(process.argv[1], 'true', { runner: { host: ${JSON.stringify(HOST)}, slots: 1, browser: 0 } });
process.stdout.write(JSON.stringify({ code: 'COMPLETED', exitCode: run.exitCode, green: run.isGreen, ms: Date.now() - started })); }
catch (error) { process.stdout.write(JSON.stringify({ code: error.code ?? error.name, ms: Date.now() - started, why: error.diagnostic ?? error.message })); }`;
  const result = runFixtureChild(process.execPath, ['--input-type=module', '-e', script, root], {
    cwd: root, env, encoding: 'utf8', timeout: 45_000, // Budget: bounded child lifetime for the real private worker protocol.
  });
  assert.equal(result.status, 0, result.context);
  const outcome = JSON.parse(result.stdout);
  assert.equal(outcome.code, 'COMPLETED', `a slow cleanup never fails the gate: ${JSON.stringify(outcome.why ?? null).slice(0, 2000)}`);
  assert.equal(outcome.green, true);
  assert.ok(outcome.ms < SLOW_CLEANUP_MS, `the result came back in ${outcome.ms} ms, before the ${SLOW_CLEANUP_MS} ms cleanup`);
  // The cleanup still runs to the end in the background: the job directory goes away.
  const jobs = join(remoteHome, '.pullboard-runner', 'jobs');
  const gone = () => !existsSync(jobs) || readdirSync(jobs).length === 0;
  // The directory's own change events say when the cleanup finished; the test timeout bounds a cleanup that never does.
  await new Promise(resolve => {
    const watcher = watch(jobs, () => { if (gone()) { watcher.close(); resolve(); } });
    if (gone()) { watcher.close(); resolve(); }
  });
  assert.deepEqual(existsSync(jobs) ? readdirSync(jobs) : [], [], 'the background cleanup removed the job directory');
});
