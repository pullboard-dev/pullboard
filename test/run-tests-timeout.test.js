/** Prove each test has a named bounded timeout and the run continues [C7, V10]. */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { DEFAULT_TEST_TIMEOUT_MS } from '../bin/run-tests.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));

/**
 * Create an isolated fixture and run its tests through the production runner.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} stalledSource
 * @param {string} timeoutOverride
 * @returns {import('node:child_process').SpawnSyncReturns<string>}
 */
function runFixture(t, stalledSource, timeoutOverride = '1200') {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-test-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const stalled = join(root, 'stalled.test.js');
  const later = join(root, 'later.test.js');
  writeFileSync(stalled, stalledSource);
  writeFileSync(later, "import { test } from 'node:test';\ntest('later file still reports [C7,V10]', () => {});\n");

  const result = spawnSync(process.execPath, [runner, stalled, later], {
    cwd: root,
    env: { ...process.env, PULLBOARD_TEST_TIMEOUT_MS: timeoutOverride },
    encoding: 'utf8',
    detached: true,
    timeout: 15_000,
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
    env: { ...process.env, PULLBOARD_TEST_TIMEOUT_MS: '0' },
    encoding: 'utf8',
    timeout: 15_000,
  });
  assert.equal(existsSync(marker), false, 'invalid timeout was refused before the fixture ran');
  assert.equal(result.status, 1, outputOf(result));
  assert.match(outputOf(result), /PULLBOARD_TEST_TIMEOUT_MS must be a positive integer no greater than 2147483647/u);
});
