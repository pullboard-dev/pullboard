/** A slow file on a loaded runner is judged by its cases, and a timeout names them [C7,V10]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureChild } from './fixture-child.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));

/** Run one fixture file under a small wall limit and return its status and combined output. */
function run(t, name, source) {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-file-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  writeFileSync(join(root, name), source);
  const result = runFixtureChild(process.execPath, [runner, join(root, name)], {
    cwd: root, encoding: 'utf8', detached: true,
    env: { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_TEST_TIMEOUT_MS: '20000',
      PULLBOARD_TEST_FILE_LIMITS: JSON.stringify({ [name]: 2000 }), PULLBOARD_TEST_IDLE_TIMEOUT_MS: '4000' },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const pause = "const pause = ms => new Promise(done => setTimeout(done, ms));\n";

test('a file whose cases each finish in budget is not failed by the whole-file wall [C7,V10]', t => {
  const cases = [1, 2, 3, 4, 5, 6].map(n => `test('case ${n} [C7]', async () => { await pause(600); });`).join('\n');
  const { status, output } = run(t, 'sum.test.js', `import { test } from 'node:test';\n${pause}${cases}\n`);
  assert.equal(status, 0, output);
  assert.doesNotMatch(output, /TIMEOUT file|HUNG file/u);
});

test('a file that stalls past its wall reports the running case and each finished case duration [C7,V10]', t => {
  const { status, output } = run(t, 'stall.test.js', [
    "import { test } from 'node:test';", pause,
    "test('first finished [C7]', async () => { await pause(300); });",
    "test('second finished [C7]', async () => { await pause(300); });",
    "test('the stuck case [C7]', () => { while (true) {} });",
  ].join('\n') + '\n');
  assert.equal(status, 1, output);
  assert.match(output, /TIMEOUT file .*stall\.test\.js" slowest running case "the stuck case \[C7\] \(running \d+ms\)": whole-file wall limit 2000ms/u);
  assert.match(output, /finished cases \[\{"name":"first finished \[C7\]","ms":\d+\},\{"name":"second finished \[C7\]","ms":\d+\}\]/u);
});
