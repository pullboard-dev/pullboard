/** Test the CI-like test runner against real Git and PATH behavior [C7, S13]. */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

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
  assert.ok(process.env.PULLBOARD_TEST_FILE.endsWith('test/test-runner.test.js'));

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
  assert.match(refused.stderr, /test-runner\.test\.js/);

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
  const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));
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

test('default discovery runs one fixture and does not recurse into the runner [C7, S13]', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-runner-discovery-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, 'bin');
  const tests = join(root, 'test');
  mkdirSync(bin);
  mkdirSync(tests);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));
  copyFileSync(runner, join(bin, 'run-tests.js'));
  const source = join(root, 'src');
  mkdirSync(source);
  for (const name of ['person.js', 'refused.js']) {
    copyFileSync(fileURLToPath(new URL('../src/' + name, import.meta.url)), join(source, name));
  }
  const marker = join(root, 'ran-once');
  writeFileSync(join(tests, 'one.test.js'), `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
test('one discovered test', () => appendFileSync(${JSON.stringify(marker)}, 'x'));
`);
  const launchEnv = { ...process.env };
  delete launchEnv.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', '--import', join(bin, 'run-tests.js')], {
    cwd: root,
    encoding: 'utf8',
    env: launchEnv,
    timeout: 15_000,
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(readFileSync(marker, 'utf8'), 'x', 'one test ran exactly once under default discovery');
});
