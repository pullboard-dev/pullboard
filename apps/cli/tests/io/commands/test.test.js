/** @pullboard-test-input source-tree */
/** Test the CI-like test runner against real Git and PATH behavior [C7, S13]. */
import { expandTestFolders } from '../../../../../packages/runners/index.js';
import assert from 'node:assert/strict';
import {
  runFixtureExecFile as execFileSync,
  privateFixtureFiles,
  runFixtureChild as spawnSync,
} from '../../fixtures/child.js';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import {
  delimiter,
  join,
} from 'node:path';
import { fileURLToPath } from 'node:url';
import { after } from 'node:test';
import { test } from 'node:test';
import { queueTestRun } from '../../../../../packages/drive/index.js';
import { runResident } from '../../../src/io/resident/client.js';
import { createE2eHelpers } from '../../fixtures/e2e.js';
import { withFixtureBoard } from '../../fixtures/board.js';

test('tests run without inherited Git identity or config and refuse ambient pullboard [C7, S13]', (t) => {
  assert.equal(process.env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(process.env.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(process.env.GIT_CONFIG_COUNT, '3');
  assert.equal(process.env.GIT_CONFIG_KEY_0, 'user.useConfigOnly');
  assert.equal(process.env.GIT_CONFIG_VALUE_0, 'true');
  assert.equal(process.env.GIT_CONFIG_KEY_1, 'gc.auto');
  assert.equal(process.env.GIT_CONFIG_VALUE_1, '0');
  assert.equal(process.env.GIT_CONFIG_KEY_2, 'maintenance.auto');
  assert.equal(process.env.GIT_CONFIG_VALUE_2, 'false');
  assert.equal(process.env.GIT_AUTHOR_NAME, undefined);
  assert.equal(process.env.GIT_AUTHOR_EMAIL, undefined);
  assert.equal(process.env.GIT_COMMITTER_NAME, undefined);
  assert.equal(process.env.GIT_COMMITTER_EMAIL, undefined);
  assert.equal(process.env.SSH_CONNECTION, undefined);
  assert.equal(process.env.SSH_CLIENT, undefined);
  assert.equal(process.env.SSH_TTY, undefined);
  assert.equal(process.env.HOME, process.env.PULLBOARD_HOME);
  assert.ok(process.env.PULLBOARD_MACHINE_HOME.startsWith(join(process.env.TMPDIR, 'machine')));
  assert.ok(process.env.PULLBOARD_TEST_FILE.endsWith('apps/cli/tests/io/commands/test.test.js'));

  const root = mkdtempSync(join(tmpdir(), 'pullboard-runner-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', root]);
  const identity = spawnSync('git', ['var', 'GIT_AUTHOR_IDENT'], { cwd: root, encoding: 'utf8' });
  assert.notEqual(identity.status, 0, 'Git refuses to infer an author identity from the machine');
  assert.match(identity.stderr, /author identity unknown/i);
  const autoGc = spawnSync('git', ['config', '--get', 'gc.auto'], { cwd: root, encoding: 'utf8' });
  const autoMaintenance = spawnSync('git', ['config', '--get', 'maintenance.auto'], { cwd: root, encoding: 'utf8' });
  assert.equal(autoGc.status, 0, autoGc.stderr);
  assert.equal(autoGc.stdout.trim(), '0');
  assert.equal(autoMaintenance.status, 0, autoMaintenance.stderr);
  assert.equal(autoMaintenance.stdout.trim(), 'false');

  const refused = spawnSync('pullboard', ['init'], { cwd: root, encoding: 'utf8' });
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /pullboard is not installed/);
  assert.match(refused.stderr, /apps\/cli\/tests\/io\/commands\/test\.test\.js/);

  const fixtureShims = join(root, 'fixture-bin');
  mkdirSync(fixtureShims);
  const fixture = join(fixtureShims, 'pullboard');
  writeFileSync(fixture, '#!/bin/sh\nprintf "fixture shim first\\n"\n');
  chmodSync(fixture, 0o755);
  const preferred = spawnSync('pullboard', ['init'], {
    cwd: root,
    env: { ...process.env, PATH: `${fixtureShims}${delimiter}${process.env.PATH}` },
    encoding: 'utf8',
  });
  assert.equal(preferred.status, 0);
  assert.match(preferred.stdout, /fixture shim first/);
});

test('runner removes its private home after test workers exit [C7, S13]', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'pullboard-runner-cleanup-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));
  const probe = join(scratch, 'runner-probe.test.js');
  const report = join(scratch, 'sandbox-path');
  writeFileSync(probe, `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
test('reports its sandbox and person-terminal markers', () => writeFileSync(${JSON.stringify(report)}, JSON.stringify({ sandbox: process.env.TMPDIR, ssh: [process.env.SSH_CONNECTION, process.env.SSH_CLIENT, process.env.SSH_TTY] })));
`);
  const runner = fileURLToPath(new URL('../../../../../apps/cli/src/io/run/tests.js', import.meta.url));
  const launchEnv = { ...process.env };
  Object.assign(launchEnv, {
    SSH_CONNECTION: '192.0.2.1 1234 192.0.2.2 22',
    SSH_CLIENT: '192.0.2.1 1234 22',
    SSH_TTY: '/dev/pts/4',
  });
  delete launchEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, [runner, probe], { encoding: 'utf8', env: launchEnv });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.ok(existsSync(report), `${result.stdout}${result.stderr}`);
  const resultEnv = JSON.parse(readFileSync(report, 'utf8'));
  const sandbox = resultEnv.sandbox;
  assert.deepEqual(resultEnv.ssh, [null, null, null], 'the runner removes every SSH transport marker before test workers act as the person');
  assert.equal(existsSync(sandbox), false, 'the private sandbox is removed after Node exits');

  const failingProbe = join(scratch, 'runner-failure.test.js');
  writeFileSync(failingProbe, "import { test } from 'node:test';\ntest('fails', () => { throw new Error('forward this failure'); });\n");
  const failed = spawnSync(process.execPath, [runner, failingProbe], { encoding: 'utf8' });
  assert.equal(failed.status, 1, `${failed.stdout}${failed.stderr}`);
  assert.match(failed.stdout, /forward this failure/);
});

const e2e = createE2eHelpers();
after(e2e.cleanup);

/** A board with one queued test run whose detached worker is a stand-in that never starts. */
function queuedRunBoard() {
  const box = e2e.project(undefined, undefined, { withWorktree: false });
  const commonDir = join(box.repo, '.git');
  const run = withFixtureBoard(join(commonDir, 'pullboard', 'board.sqlite'), board => queueTestRun({ info: { commonDir, root: box.repo } },
    work => work(board), { agent: 'seat', files: ['test/a.test.js'] }, { launch: () => ({ unref() {} }) }));
  return { box, run, commonDir };
}

test('clause 1: test --status prints the run state without spawning the resident board [C7,#5888]', async () => {
  const { box, run, commonDir } = queuedRunBoard();
  const env = { ...box.env, PULLBOARD_RESIDENT: '1' };
  const quiet = { write() { return true; }, isTTY: false };
  const started = [];
  const start = place => started.push(place);
  assert.equal(await runResident(['test', '--status', run.id], { cwd: box.repo, env, stdout: quiet, stderr: quiet, start }), null);
  assert.deepEqual(started, [], 'test --status with no resident process reads in-process and starts none');
  assert.equal(await runResident(['show', '1'], { cwd: box.repo, env, stdout: quiet, stderr: quiet, start }), null);
  assert.equal(started.length, 1, 'control: another resident command with no process does start one');
  const status = await box.inProcess(box.repo, 'test', '--status', run.id);
  assert.equal(status.code, 0, `${status.out}${status.err}`);
  assert.match(status.out, new RegExp(`test run ${run.id} queued: test/a\\.test\\.js`, 'u'));
  const residents = readdirSync(join(commonDir, 'pullboard')).filter(name => name.startsWith('resident-'));
  assert.deepEqual(residents, [], 'no resident board process recorded itself');
});

test('clause 2: test --status of an unknown run id still refuses with a next step [C7,#5888]', async () => {
  const { box } = queuedRunBoard();
  const refused = await box.inProcess(box.repo, 'test', '--status', '00000000-0000-4000-8000-000000000000');
  assert.equal(refused.code, 1, `${refused.out}${refused.err}`);
  assert.match(refused.err, /\[NO_TEST_RUN\]/u);
  assert.match(refused.err, /^next: /mu);
});

test('pullboard test given a folder expands it to the test files under it, never ERR_UNSUPPORTED_DIR_IMPORT [C7,S13]', (t) => {
  const box = privateFixtureFiles('pullboard-test-folders-');
  const root = box.root;
  t.after(() => box.cleanup?.());
  for (const file of ['dir/b.test.js', 'dir/sub/a.test.js', 'dir/helper.js', 'empty/readme.txt']) box.write(file, 'export {};\n');
  assert.deepEqual(expandTestFolders(root, ['dir/', 'x.test.js']), ['dir/b.test.js', 'dir/sub/a.test.js', 'x.test.js']);
  assert.throws(() => expandTestFolders(root, ['empty']), (error) => error.code === 'NO_TEST_FILE' && /empty/u.test(error.message));
});
