/** A test run beats its seat's heartbeat while it runs and stops when told; a directory without a seat beats nothing [B3,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { keepSeatAlive } from '../../src/io/keepalive.js';

/** An injected scheduler: the test fires the registered tick itself, so no real timer is waited on. */
function scheduler() {
  const timers = [];
  return { timers,
    every: (tick, ms) => { const timer = { tick, ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { timer.cancelled = true; } };
}

test('gate.io-keepalive.the-seat-is-beaten-on-each: clause 1: the seat is beaten on each tick with its board file, every minute by default, and never after stop [B3,C7]', () => {
  const beats = [], clock = scheduler();
  const stop = keepSeatAlive('/any/checkout', { ...clock,
    seatOf: () => ({ seat: 'core-7', item: 12, file: '/repo/.git/pullboard/seat-timing.jsonl' }),
    beat: (file, seat) => beats.push([file, seat]) });
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, 60_000, 'one beat a minute, well inside the two-minute seat-gone limit');
  clock.timers[0].tick(); clock.timers[0].tick();
  assert.deepEqual(beats, [['/repo/.git/pullboard/board.sqlite', 'core-7'], ['/repo/.git/pullboard/board.sqlite', 'core-7']]);
  stop();
  assert.equal(clock.timers[0].cancelled, true, 'stop cancels the timer');
});

test('gate.io-keepalive.a-directory-with-no-seat-registers: clause 2: a directory with no seat registers no timer [B3,C7]', () => {
  const clock = scheduler();
  const stop = keepSeatAlive('/no/seat', { ...clock, seatOf: () => null, beat: () => { throw new Error('no beat'); } });
  stop();
  assert.equal(clock.timers.length, 0);
});
