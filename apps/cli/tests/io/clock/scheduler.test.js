/** The clock pass runs every minute on its own registered timer, single flight [B4,C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClockTimer } from '../../../src/io/clock/scheduler.js';

const MINUTE = 60_000;

/** A fake clock: timers fire in due order as time is advanced, and nothing ever sleeps. */
function fakeClock() {
  let time = 1_000_000, nextId = 1;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: time + ms }); return id; },
    clearTimer: id => { timers.delete(id); },
    /** Advance to `target`, firing each due timer at its own moment. */
    async advance(ms) {
      const target = time + ms;
      for (;;) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        time = due[1].at;
        due[1].fn();
        await new Promise(resolve => setImmediate(resolve));
      }
      time = target;
    },
  };
}

test('cli.io-clock-scheduler.every-minute: clause 1: with a fake clock the watch runs one clock pass per 60 s for five simulated minutes and registers the next run after each one [B4,C7]', async () => {
  const clock = fakeClock(), start = clock.now(), registered = [];
  let passes = 0;
  const timer = createClockTimer({ ...clock, runPass: async () => { passes += 1; }, register: due => registered.push(due) });
  timer.start();
  assert.deepEqual(registered, [start + MINUTE], 'the first run is registered at start');
  await clock.advance(5 * MINUTE);
  timer.stop();
  assert.equal(passes, 5, 'one pass per minute for five minutes');
  assert.equal(timer.stats.completed, 5);
  assert.equal(timer.stats.skipped, 0);
  assert.deepEqual(registered, [1, 2, 3, 4, 5, 6].map(n => start + n * MINUTE), 'each pass registers the next run');
  await clock.advance(3 * MINUTE);
  assert.equal(passes, 5, 'a stopped timer runs nothing more');
});

test('cli.io-clock-scheduler.single-flight: clause 2: a pass still running when the next is due is skipped and counted, never run twice at once [B4,C7]', async () => {
  const clock = fakeClock();
  let active = 0, peak = 0, passes = 0, release;
  const runPass = () => new Promise(resolve => {
    passes += 1; active += 1; peak = Math.max(peak, active);
    release = () => { active -= 1; resolve(); };
  });
  const timer = createClockTimer({ ...clock, runPass, register: () => {} });
  timer.start();
  await clock.advance(MINUTE);
  assert.equal(passes, 1);
  await clock.advance(2 * MINUTE);
  assert.equal(passes, 1, 'no second pass starts while the first runs');
  assert.equal(timer.stats.skipped, 2, 'the two due moments are counted as skipped');
  release();
  await new Promise(resolve => setImmediate(resolve));
  await clock.advance(MINUTE);
  assert.equal(passes, 2, 'the next pass starts once the first has finished');
  assert.equal(peak, 1, 'never two passes at once');
  release();
  timer.stop();
});
