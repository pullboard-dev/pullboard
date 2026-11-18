/** A review accept says what it waits on every minute and stops at its deadline instead of blocking silently [C7,#10935]. @pullboard-test-input source-cell apps/cli */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { reviewWait } from '../../../src/io/verify/wait.js';
import { reviewWaitMs } from '../../../src/io/verify/wait.js';
import { REVIEW_WAIT_MS } from '../../../src/io/verify/wait.js';

/** A hand-driven clock and timer table: advance(ms) fires every due timer in time order, oldest first on a tie. */
function fakeTimers() {
  let at = 0, next = 1;
  const live = new Map();
  const firstDue = end => [...live.entries()].filter(([, row]) => row.due <= end).sort((a, b) => a[1].due - b[1].due || a[0] - b[0])[0];
  return {
    now: () => at,
    live,
    timers: {
      setTimeout: (fn, ms) => { const id = next++; live.set(id, { fn, due: at + ms }); return id; },
      clearTimeout: id => live.delete(id),
    },
    advance(ms) {
      const end = at + ms;
      let due = firstDue(end);
      while (due) {
        const [id, row] = due;
        at = row.due;
        live.delete(id);
        row.fn();
        due = firstDue(end);
      }
      at = end;
    },
  };
}

const flush = () => new Promise(resolve => setImmediate(resolve));

test('cli.io-verify-wait.start-and-still-waiting-lines-then-quiet: clause 1: the wait names what it waits on and its deadline, says it is still waiting each minute, and once the action settles returns its result, prints nothing more and leaves no timer [C7,#10935]', async () => {
  const clock = fakeTimers();
  const lines = [];
  let finish;
  const waiting = reviewWait({ say: line => lines.push(line) }, { item: 10149, what: 'the review check at ebb2c76c2263 on a runner', deadlineMs: 45 * 60_000, now: clock.now, timers: clock.timers },
    () => new Promise(resolve => { finish = resolve; }));
  await flush();
  assert.deepEqual(lines, ['#10149 accept waits on the review check at ebb2c76c2263 on a runner; it gives up after 45 min']);
  clock.advance(3 * 60_000);
  assert.deepEqual(lines.slice(1), [1, 2, 3].map(m => `#10149 accept still waiting on the review check at ebb2c76c2263 on a runner: ${m} of 45 min`));
  finish({ state: 'pass' });
  assert.deepEqual(await waiting, { state: 'pass' });
  const printed = lines.length;
  clock.advance(60 * 60_000);
  assert.equal(lines.length, printed, 'no line after the action settles');
  assert.equal(clock.live.size, 0, 'no timer left running');
});

test('cli.io-verify-wait.deadline-aborts-the-signal-and-refuses: clause 2: a wait past its deadline aborts the signal handed to the action and rejects with REVIEW_WAIT_DEADLINE naming what it waited on and that no verdict was recorded, even when the action ignores the signal [C7,#10935]', async () => {
  const clock = fakeTimers();
  const lines = [];
  let handed;
  const what = 'main f8216f494f48 comparison of the failing cases on a runner';
  const waiting = reviewWait({ say: line => lines.push(line) }, { item: 10149, what, deadlineMs: 5 * 60_000, now: clock.now, timers: clock.timers },
    signal => { handed = signal; return new Promise(() => {}); }); // Ignores the signal and never settles, like a queued runner job.
  await flush();
  assert.equal(handed.aborted, false);
  clock.advance(5 * 60_000);
  await assert.rejects(waiting, error => {
    assert.equal(error.code, 'REVIEW_WAIT_DEADLINE');
    assert.match(error.message, new RegExp(`waited 5 min on ${what}`));
    assert.match(error.message, /no verdict was recorded/);
    assert.match(error.message, /pullboard verify 10149 accept again/);
    return true;
  });
  assert.equal(handed.aborted, true, 'the action is told to stop its runner job');
  assert.equal(handed.reason.code, 'REVIEW_WAIT_DEADLINE');
  assert.equal(clock.live.size, 0, 'no timer left running');
  assert.equal(reviewWaitMs({}), REVIEW_WAIT_MS);
  assert.equal(reviewWaitMs({ PULLBOARD_REVIEW_WAIT_MS: '90000' }), 90_000);
  assert.equal(reviewWaitMs({ PULLBOARD_REVIEW_WAIT_MS: 'soon' }), REVIEW_WAIT_MS);
});
