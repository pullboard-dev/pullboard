/** A test file that never finishes is killed at the per-file budget and reported as a timeout red [C7]. */
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FILE_BUDGET_MS } from '../../../../packages/drive/light.js';
import { fileWatchdogLimits } from '../../../../packages/drive/light.js';
import { privateFixtureFiles } from '../../tests/fixtures/child.js';
import { runFixtureChild } from '../../tests/fixtures/child.js';

const runner = fileURLToPath(new URL('../../../../packages/gate/src/io/run/tests.js', import.meta.url));
const CHATTER = `import { test } from 'node:test';
test('chatty hang [C7]', () => {
  for (let n = 1; ; n++) {
    console.log('tick ' + n);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
});
`;

/** Run the production runner on a never-finishing file and a passing sibling, with the budget cut to seconds. */
function runHung(t, env = {}) {
  const box = privateFixtureFiles('pullboard-file-budget-');
  const { root } = box;
  t.after(() => rmSync(root, { recursive: true, force: true }));
  box.write('package.json', JSON.stringify({ type: 'module' }));
  box.write('hang.test.js', CHATTER);
  box.write('later.test.js', "import { test } from 'node:test';\ntest('sibling still reports [C7]', () => {});\n");
  const started = Date.now();
  const result = runFixtureChild(process.execPath, [runner, join(root, 'hang.test.js'), join(root, 'later.test.js')], {
    cwd: root, encoding: 'utf8', detached: true, timeout: 60_000,
    env: { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_TEST_FILE_BUDGET_MS: '2000', ...env },
  });
  if (result.error?.code === 'ETIMEDOUT' && result.pid) {
    try { process.kill(-result.pid, 'SIGKILL'); } catch { /* The owned fixture group already exited. */ }
  }
  return { result, seconds: (Date.now() - started) / 1000, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

test('clause 1: the default per-file budget is three minutes and a smaller override wins [C7]', () => {
  assert.equal(DEFAULT_FILE_BUDGET_MS, 180_000);
  assert.equal(fileWatchdogLimits('a.test.js', {}).budgetMs, 180_000);
  assert.equal(fileWatchdogLimits('a.test.js', { PULLBOARD_TEST_FILE_BUDGET_MS: '2000' }).budgetMs, 2000);
  assert.throws(() => fileWatchdogLimits('a.test.js', { PULLBOARD_TEST_FILE_BUDGET_MS: '0' }), /PULLBOARD_TEST_FILE_BUDGET_MS must be a positive integer/u);
});

test('clause 1: a chatty file that never finishes is killed at the budget with its last output, freeing the slot [C7]', t => {
  const { result, seconds, output } = runHung(t);
  assert.equal(result.status, 1, output);
  assert.equal((output.match(/TIMEOUT file .*hang\.test\.js.*per-file budget 2000ms/gu) ?? []).length, 1, output);
  assert.match(output, /last output:[\s\S]*tick \d+/u, 'the red carries the file\'s last output lines');
  assert.ok(seconds < 30, `the run ended ${seconds}s in: the killed file freed its slot instead of holding it`); // budget: hang ceiling far above the 2 s budget; not a speed target.
  assert.match(output, /ok \d+ - sibling still reports/u);
});
