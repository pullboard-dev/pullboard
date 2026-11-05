/** The whole-file wall limit scales with machine load and a late file reports TIMEOUT [C7,V10]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFixtureChild } from './fixture-child.js';
import { DEFAULT_FILE_WALL_MS, fileWatchdogLimits, wallLoadFactor } from '../packages/verify/index.js';

const runner = fileURLToPath(new URL('../bin/run-tests.js', import.meta.url));

test('the load factor is load per core, never below 1x and never above 4x [C7,V10]', () => {
  assert.equal(wallLoadFactor(0.5, 14), 1);
  assert.equal(wallLoadFactor(14, 14), 1);
  assert.equal(wallLoadFactor(28, 14), 2);
  assert.equal(wallLoadFactor(120, 14), 4);
  assert.equal(wallLoadFactor(Number.NaN, 14), 1);
});

test('the default wall scales with the load sampled at file start and records the limit used [C7,V10]', () => {
  const idle = fileWatchdogLimits('a.test.js', {}, { load: 1, cores: 14 });
  assert.deepEqual([idle.wallMs, idle.baseWallMs, idle.loadFactor], [DEFAULT_FILE_WALL_MS, DEFAULT_FILE_WALL_MS, 1]);
  const busy = fileWatchdogLimits('a.test.js', {}, { load: 42, cores: 14 });
  assert.equal(busy.loadFactor, 42 / 14);
  assert.equal(busy.wallMs, Math.round(DEFAULT_FILE_WALL_MS * 42 / 14));
  const saturated = fileWatchdogLimits('a.test.js', {}, { load: 400, cores: 14 });
  assert.equal(saturated.wallMs, DEFAULT_FILE_WALL_MS * 4);
});

test('an explicit limit is used exactly as written, whatever the load [C7,V10]', () => {
  const written = { file: '1500', env: '2000' };
  const env = { PULLBOARD_TEST_FILE_LIMITS: JSON.stringify({ 'a.test.js': Number(written.file) }) };
  assert.equal(fileWatchdogLimits('a.test.js', env, { load: 400, cores: 14 }).wallMs, Number(written.file));
  assert.equal(fileWatchdogLimits('b.test.js', { PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: written.env }, { load: 400, cores: 14 }).wallMs, Number(written.env));
});

test('a file past its wall is a TIMEOUT naming its slowest running case, not a plain failure [C7,V10]', t => {
  const root = mkdtempSync(join(tmpdir(), 'pullboard-wall-timeout-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module' }));
  const file = join(root, 'slow.test.js');
  writeFileSync(file, "import { test } from 'node:test';\ntest('the long case [C7]', () => { while (true) {} });\n");
  const result = runFixtureChild(process.execPath, [runner, file], {
    cwd: root, encoding: 'utf8', detached: true,
    env: { ...process.env, PULLBOARD_MACHINE_HOME: join(root, 'machine'), PULLBOARD_TEST_TIMEOUT_MS: '60000',
      PULLBOARD_TEST_FILE_LIMITS: JSON.stringify({ 'slow.test.js': 1500 }), PULLBOARD_TEST_IDLE_TIMEOUT_MS: '60000' },
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  assert.equal(result.status, 1, output);
  assert.match(output, /TIMEOUT file .*slow\.test\.js" slowest running case "the long case \[C7\] \(running \d+ms\)": whole-file wall limit 1500ms/u);
  assert.doesNotMatch(output, /HUNG file/u);
});
