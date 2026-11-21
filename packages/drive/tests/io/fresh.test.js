/** The serve restart trial: a move to new code is tried on the claim path before the socket is handed over [C7,#12118]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { claimTrial } from '../../index.js';
import { restartOnCodeMove } from '../../index.js';

const FROM = 'a'.repeat(40);
const TO = 'b'.repeat(40);

/**
 * Run restartOnCodeMove through one code move with the given trial and report what it did: the order of its calls and its log lines.
 * `settled` is true when the restart finished; false when the old process was still serving after the move was judged.
 */
async function moveOnce(t, trial) {
  const order = [];
  const lines = [];
  let revision = FROM;
  let judged;
  const done = new Promise((resolve) => { judged = resolve; });
  const fresh = restartOnCodeMove({ root: '.', revision: () => revision, interval: 5, drain: 1_000, handoff: true, trial,
    log: (line) => { lines.push(line); if (/refused|could not run/u.test(line)) judged(); },
    close: async () => { order.push('close'); },
    relaunch: async () => { order.push('relaunch'); return { pid: 7, listening: true }; } });
  const hold = setInterval(() => {}, 1_000); // the watcher's timer is unref'd; this test holds the loop open
  t.after(() => { clearInterval(hold); fresh.stop(); });
  revision = TO;
  const settled = await Promise.race([fresh.restarted.then(() => true), done.then(() => new Promise((resolve) => setTimeout(() => resolve(false), 60)))]);
  return { order, lines, settled };
}

/** Figures a trial reports: the old process measured at p95 10 ms and 50 ms of CPU. */
const OLD = { p95: 10, cpuMs: 50 };
const stubTrial = (next, old = OLD) => ({ old: () => old, next: () => next });

test('drive.io-fresh.trial-keeps-old: clause 1: with serve.restartTrial on, a new process whose trial p95 is over 1 s, over 2x the old p95 or whose CPU is over 2x the old keeps the old process listening, hands over no socket and logs one line with both p95s and the commit [C7,#12118]', async (t) => {
  const refused = [
    ['p95 over 1 s', { p95: 1_001, cpuMs: 50 }, { p95: 900, cpuMs: 500 }],
    ['p95 over 2x the old', { p95: 21, cpuMs: 50 }, OLD],
    ['CPU over 2x the old', { p95: 10, cpuMs: 101 }, OLD],
  ];
  for (const [why, next, old] of refused) {
    const moved = await moveOnce(t, stubTrial(next, old));
    assert.equal(moved.settled, false, `${why}: the old process keeps serving`);
    assert.deepEqual(moved.order, [], `${why}: no new process starts and no socket moves`);
    assert.equal(moved.lines.length, 1, `${why}: one log line: ${moved.lines.join(' | ')}`);
    assert.match(moved.lines[0], new RegExp(`${TO.slice(0, 10)}.*p95 ${next.p95.toFixed(2)} ms.*p95 ${old.p95.toFixed(2)} ms`, 'u'), why);
  }
  // The same refusal through claimTrial, with the claims injected: the port takes the old process's measurement and the new code's.
  const asked = [];
  const injected = claimTrial({ claims: (options) => { asked.push(options); return OLD; }, db: 'board.db', root: '.', count: 7, next: (to, options) => { asked.push({ to, ...options }); return { p95: 1_500, cpuMs: 50 }; } });
  const moved = await moveOnce(t, injected);
  assert.equal(moved.settled, false, 'claims injected through claimTrial are judged the same way');
  assert.deepEqual(moved.order, []);
  assert.deepEqual(asked, [{ db: 'board.db', root: '.', count: 7 }, { to: TO, db: 'board.db', root: '.', count: 7 }], 'both sides ran the same count on the same board');
});

test('drive.io-fresh.trial-passes-hands-over: clause 2: a trial within the thresholds hands over as before, and with the setting off nothing changes and no trial runs [C7,#12118]', async (t) => {
  const ran = [];
  const within = { old: () => { ran.push('old'); return OLD; }, next: () => { ran.push('next'); return { p95: 20, cpuMs: 100 }; } };
  const passed = await moveOnce(t, within);
  assert.equal(passed.settled, true);
  assert.deepEqual(passed.order, ['relaunch', 'close'], 'the new process listens first, then this one stops');
  assert.deepEqual(ran, ['old', 'next'], 'a trial on measures this process, then the new code');
  ran.length = 0;
  const off = await moveOnce(t, null);
  assert.equal(off.settled, true);
  assert.deepEqual(off.order, ['relaunch', 'close']);
  assert.deepEqual(ran, [], 'with the setting off no trial runs');
  assert.equal(off.lines.some((line) => /trial/u.test(line)), false, 'and it says nothing of one');
});
