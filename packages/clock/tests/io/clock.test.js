/** @pullboard-test-input source-cell packages/clock */
/** The clock adapter returns the injected source, or the real one by default, and no other cell reaches it yet [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as kernel from '../../../kernel/index.js';
import * as kernelLight from '../../../kernel/light.js';
import { clockAdapter } from '../../index.js';

test('clock.adapter.returns-the-source: clause 1: the adapter returns what the injected source returns [C7]', () => {
  const cancelled = [];
  const clock = clockAdapter({ now: () => 42, setTimeout: () => 'timer', clearTimeout: (h) => cancelled.push(h) });
  assert.equal(clock.now(), 42);
  assert.equal(clock.setTimeout(() => {}, 1), 'timer');
  clock.clearTimeout('timer');
  assert.deepEqual(cancelled, ['timer']);
});

test('clock.adapter.real-by-default: clause 1: the adapter reads the real clock by default [C7]', async () => {
  const before = Date.now();
  const clock = clockAdapter();
  const read = clock.now();
  assert.ok(read >= before && read <= Date.now());
  await new Promise((resolve) => { clock.setTimeout(resolve, 1); });
  let fired = false;
  const handle = clock.setTimeout(() => { fired = true; }, 5);
  clock.clearTimeout(handle);
  await new Promise((resolve) => { clock.setTimeout(resolve, 15); });
  assert.equal(fired, false);
});

test('clock.adapter.fake-is-deterministic: clause 1: a fake source makes the answer deterministic [C7]', () => {
  let current = 1000;
  const clock = clockAdapter({ now: () => current, setTimeout: () => 0, clearTimeout() {} });
  assert.equal(clock.now(), 1000);
  assert.equal(clock.now(), 1000);
  current = 1055;
  assert.equal(clock.now(), 1055);
});

test('clock.adapter.kernel-gains-no-export: clause 2: the kernel exports no clock adapter, so no existing behaviour changes [C7]', () => {
  assert.equal('clockAdapter' in kernel, false);
  assert.equal('clockAdapter' in kernelLight, false);
  assert.equal(typeof clockAdapter, 'function');
});
