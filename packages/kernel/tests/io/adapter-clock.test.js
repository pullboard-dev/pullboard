/** @pullboard-test-input packages/kernel/index.js */
/** The kernel clock adapter returns its source's time, defaults to the real clock, and a fake makes time deterministic [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as light from '../../light.js';
import { createClock } from '../../index.js';
import { createFakeClock } from '../../index.js';

test('clause 1: the clock returns what the injected source returns [C7]', () => {
  const clock = createClock({ now: () => 42, setTimeout: () => 'timer', clearTimeout() {} });
  assert.equal(clock.now(), 42);
  assert.equal(clock.setTimeout(() => {}, 1), 'timer');
});

test('clause 1: the default source is the real clock [C7]', async () => {
  const before = Date.now();
  const clock = createClock();
  assert.ok(clock.now() >= before && clock.now() <= Date.now());
  await new Promise(resolve => { clock.setTimeout(resolve, 1); });
});

test('clause 1: a fake source is deterministic and fires timers in order on advance [C7]', () => {
  const clock = createFakeClock(1000);
  const seen = [];
  clock.setTimeout(() => seen.push(['late', clock.now()]), 50);
  clock.setTimeout(() => seen.push(['early', clock.now()]), 10);
  const cancelled = clock.setTimeout(() => seen.push(['never']), 5);
  clock.clearTimeout(cancelled);
  assert.equal(clock.now(), 1000);
  clock.advance(45);
  assert.deepEqual(seen, [['early', 1010]]);
  clock.advance(10);
  assert.deepEqual(seen, [['early', 1010], ['late', 1050]]);
  assert.equal(clock.now(), 1055);
  assert.equal(clock.pending(), 0);
});

test('clause 2: the runner light door does not export the clock, so no existing behaviour changes [C7]', () => {
  assert.equal('createClock' in light, false);
  assert.equal('createFakeClock' in light, false);
  assert.equal(typeof createClock, 'function');
});
