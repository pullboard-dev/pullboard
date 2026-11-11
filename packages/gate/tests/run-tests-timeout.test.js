/** Prove each test has a named bounded timeout and the run continues [C7, V10]. */
import assert from 'node:assert/strict';
import { runFixtureChild as spawnSync } from '../../../apps/cli/tests/fixtures/child.js';
import { existsSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { rmSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_TEST_TIMEOUT_MS } from '../src/io/run-tests.js';

const runner = fileURLToPath(new URL('../src/io/run/tests.js', import.meta.url));

/**
 * Create an isolated fixture and run its tests through the production runner.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} stalledSource
 * @param {string} timeoutOverride
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runFixture(t, stalledSource, timeoutOverride = '1200', watchdogEnv = {}, runnerArgs = []) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-test-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const stalled = join(root, 'stalled.test.js');
  const later = join(root, 'later.test.js');
  writeFileSync(stalled, stalledSource);
  writeFileSync(later, "import { test } from 'node:test';\ntest('later file still reports [C7,V10]', () => {});\n");

  const result = spawnSync(process.execPath, [runner, ...runnerArgs, stalled, later], {
    cwd: root,
    env: { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_TEST_TIMEOUT_MS: timeoutOverride, ...watchdogEnv },
    encoding: 'utf8',
    detached: true,
  });
  if (result.error?.code === 'ETIMEDOUT' && result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch { /* The owned fixture process group already exited. */ }
  }
  return result;
}

/**
 * Combine child output without hiding the runner's diagnostic channel.
 *
 * @param {import('node:child_process').SpawnSyncReturns<string>} result
 * @returns {string}
 */
function outputOf(result) {
  return `${result.stdout ?? ''}${result.stderr ?? ''}`;
}

test('a never-settling test fails by name and later files still report [C7, V10]', (t) => {
  assert.equal(DEFAULT_TEST_TIMEOUT_MS, 660_000, '660 seconds exceeds three times the measured 213.2-second slowest test');
  const result = runFixture(t, `import { test } from 'node:test';
test('before timeout target passes [C7,V10]', () => {});
test('awaited timeout target [C7,V10]', async (context) => {
  const keepAlive = setTimeout(() => {}, 30000);
  context.after(() => clearTimeout(keepAlive));
  await new Promise(() => {});
});
`);
  const output = outputOf(result);
  assert.equal(result.status, 1, output);
  assert.match(output, /test "awaited timeout target \[C7,V10\]" in .*stalled\.test\.js failed: it ran .*past the 1200ms per-test timeout/u);
  assert.match(output, /ok \d+ - before timeout target passes \[C7,V10\]/u);
  assert.match(output, /ok \d+ - later file still reports \[C7,V10\]/u);
});

test('a synchronous test hang is named while another file reports [C7, V10]', (t) => {
  const result = runFixture(t, `import { test } from 'node:test';
test('synchronous timeout target [C7,V10]', () => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); });
`);
  const output = outputOf(result);
  assert.equal(result.status, 1, output);
  assert.match(output, /test "synchronous timeout target \[C7,V10\]" in .*stalled\.test\.js failed: it ran .*past the 1200ms per-test timeout/u);
  assert.match(output, /ok \d+ - later file still reports \[C7,V10\]/u);
});

test('test-owned synchronous cleanup retains its case budget before file exit [C7,V10]', t => {
  const result = runFixture(t, `import { test } from 'node:test';
test('cleanup inside the case budget [C7,V10]', t => {
  t.after(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500));
});
`, '5000', { PULLBOARD_TEST_FILE_TIMEOUT_MS: '500', PULLBOARD_TEST_IDLE_TIMEOUT_MS: '10000' });
  assert.equal(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /ok \d+ - cleanup inside the case budget/u);
  assert.doesNotMatch(outputOf(result), /file-exit timeout/u);
});

test('a helper-only test file exits after importing the runner [C7, V10]', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-test-timeout-helper-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const helper = join(root, 'helper.js');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(helper, 'export const helperLoaded = true;\n');

  const result = spawnSync(process.execPath, [runner, helper], {
    cwd: root,
    env: { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_TEST_TIMEOUT_MS: '1200' },
    encoding: 'utf8',
    detached: true,
  });
  if (result.error?.code === 'ETIMEDOUT' && result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch { /* The owned fixture process group already exited. */ }
  }
  assert.equal(result.status, 0, outputOf(result));
  assert.equal(result.signal, null, 'the helper exits normally without a test lifecycle');
});

test('an invalid test-timeout override refuses before running a test [C7, V10]', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-test-timeout-invalid-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, 'ran');
  const probe = join(root, 'probe.test.js');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(probe, `import { test } from 'node:test';
import { writeFileSync } from 'node:fs';
test('must not run [C7,V10]', () => writeFileSync(${JSON.stringify(marker)}, 'ran'));
`);
  const result = spawnSync(process.execPath, [runner, probe], {
    cwd: root,
    env: { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_TEST_TIMEOUT_MS: '0' },
    encoding: 'utf8',
  });
  assert.equal(existsSync(marker), false, 'invalid timeout was refused before the fixture ran');
  assert.equal(result.status, 1, outputOf(result));
  assert.match(outputOf(result), /PULLBOARD_TEST_TIMEOUT_MS must be a positive integer no greater than 2147483647/u);
});

test('a silent awaited file is HUNG by idle CPU supervision and its sibling still passes [C7,V10]', t => {
  const result = runFixture(t, `import { test } from 'node:test';
test('idle target [C7,V10]', async () => {
  setInterval(() => {}, 10000);
  await new Promise(() => {});
});
`, '60000', { PULLBOARD_TEST_IDLE_TIMEOUT_MS: '250', PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: '60000' });
  const output = outputOf(result);
  assert.equal(result.status, 1, output);
  assert.equal((output.match(/HUNG file .*stalled\.test\.js.*test "idle target \[C7,V10\]"/gu) ?? []).length, 1, output);
  assert.match(output, /silent and under 1% CPU/u);
  assert.equal((output.match(/ok \d+ - later file still reports \[C7,V10\]/gu) ?? []).length, 1, output);
  assert.doesNotMatch(output, /whole-file wall limit|per-test timeout/u);
});

// A case inside its own per-test budget keeps that budget past the file wall (#2827), so the wall bounds a busy
// file outside any case: a spin in file setup, before a test starts, never waits on a 60-second case budget.
test('clause 1: a busy file reaches its per-file wall limit and its sibling still passes [C7,V10]', t => {
  const result = runFixture(t, `import { test } from 'node:test';
const until = Date.now() + 30000;
while (Date.now() < until) {}
test('busy target [C7,V10]', () => {});
`, '60000', { PULLBOARD_TEST_IDLE_TIMEOUT_MS: '250', PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: '60000',
    PULLBOARD_TEST_FILE_LIMITS: JSON.stringify({ 'stalled.test.js': 1500 }) });
  const output = outputOf(result);
  assert.equal(result.status, 1, output);
  assert.equal((output.match(/TIMEOUT file .*stalled\.test\.js.*slowest running case "<file setup or cleanup>"/gu) ?? []).length, 1, output);
  assert.match(output, /whole-file wall limit 1500ms/u);
  assert.equal((output.match(/ok \d+ - later file still reports \[C7,V10\]/gu) ?? []).length, 1, output);
});

test('a HUNG landing file stays red and a queued sibling runs after it [C7,V10]', t => {
  const result = runFixture(t, `import { test } from 'node:test';
test('landing idle target [C7,V10]', async () => {
  setInterval(() => {}, 10000);
  await new Promise(() => {});
});
`, '60000', { PULLBOARD_LANDING_RUN: '1', PULLBOARD_TEST_IDLE_TIMEOUT_MS: '250',
    PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: '60000' }, ['--test-concurrency=1']);
  const output = outputOf(result);
  assert.equal(result.status, 1, output);
  assert.equal((output.match(/HUNG file .*stalled\.test\.js.*test "landing idle target \[C7,V10\]"/gu) ?? []).length, 1, output);
  assert.equal((output.match(/ok \d+ - later file still reports \[C7,V10\]/gu) ?? []).length, 1, output);
  assert.doesNotMatch(output, /Landing gate stopped early|Files not run:/u);
});

test('a busy descendant keeps its test file alive for two minutes [C7,V10]', t => {
  const result = runFixture(t, `import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
test('working child [C7,V10]', () => {
  execFileSync(process.execPath, ['-e', 'const end=Date.now()+120000; while(Date.now()<end) {}']);
});
`, '180000', { PULLBOARD_TEST_IDLE_TIMEOUT_MS: '2000', PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: '180000' });
  assert.equal(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /ok \d+ - working child \[C7,V10\]/u);
  assert.doesNotMatch(outputOf(result), /HUNG file/u);
});

test('output from a quiet descendant keeps its file alive [C7,V10]', t => {
  const result = runFixture(t, `import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
test('output child [C7,V10]', () => {
  execFileSync(process.execPath, ['-e', "let n=0; const timer=setInterval(()=>{console.log('progress'); if(++n===8)clearInterval(timer)},300)"], { stdio: 'inherit' });
});
`, '10000', { PULLBOARD_TEST_IDLE_TIMEOUT_MS: '1000', PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: '10000' });
  assert.equal(result.status, 0, outputOf(result));
  assert.match(outputOf(result), /ok \d+ - output child \[C7,V10\]/u);
  assert.doesNotMatch(outputOf(result), /HUNG file/u);
});
