/** Whole-file supervision policy uses deterministic samples, not elapsed-time margins [C7,V10]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DEFAULT_FILE_WALL_MS } from '../../../index.js';
import { DEFAULT_FILE_IDLE_MS } from '../../../index.js';
import { fileWatchdogLimits } from '../../../index.js';
import { fileIdleHung } from '../../../index.js';

test('whole-file limits default to five minutes and select exact file overrides [C7,V10]', () => {
  assert.deepEqual(fileWatchdogLimits('test/a.test.js', {}), { wallMs: 300_000, baseWallMs: 300_000, loadFactor: 1, budgetMs: 180_000, idleMs: 90_000 });
  assert.equal(DEFAULT_FILE_WALL_MS, 300_000);
  assert.equal(DEFAULT_FILE_IDLE_MS, 90_000);
  const env = { PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: '600000', PULLBOARD_TEST_IDLE_TIMEOUT_MS: '200000',
    PULLBOARD_TEST_FILE_LIMITS: JSON.stringify({ 'test/a.test.js': 900000 }) };
  assert.deepEqual(fileWatchdogLimits('test/a.test.js', env), { wallMs: 900000, baseWallMs: 900000, loadFactor: 1, budgetMs: 900000, idleMs: 200000 });
  assert.deepEqual(fileWatchdogLimits('test/b.test.js', env), { wallMs: 600000, baseWallMs: 600000, loadFactor: 1, budgetMs: 180000, idleMs: 200000 });
  for (const value of ['0', '-1', 'NaN', '2147483648']) {
    assert.throws(() => fileWatchdogLimits('x', { PULLBOARD_TEST_FILE_WALL_TIMEOUT_MS: value }));
    assert.throws(() => fileWatchdogLimits('x', { PULLBOARD_TEST_IDLE_TIMEOUT_MS: value }));
    assert.throws(() => fileWatchdogLimits('x', { PULLBOARD_TEST_FILE_LIMITS: JSON.stringify({ x: value }) }));
  }
  for (const value of ['[]', 'null', '{']) assert.throws(() => fileWatchdogLimits('x', { PULLBOARD_TEST_FILE_LIMITS: value }));
});

test('idle classification requires a complete silent window and less than one percent CPU [C7,V10]', () => {
  assert.equal(fileIdleHung({ quietMs: 89_999, cpuMicros: 0 }, 90_000), false);
  assert.equal(fileIdleHung({ quietMs: 90_000, cpuMicros: 899_999 }, 90_000), true);
  assert.equal(fileIdleHung({ quietMs: 90_000, cpuMicros: 900_000 }, 90_000), false);
  assert.equal(fileIdleHung({ quietMs: 90_000, cpuMicros: 90_000_000 }, 90_000), false);
});
