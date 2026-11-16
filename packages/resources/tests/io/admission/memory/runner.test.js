/** An idle runner kept for timed checks admits ordinary work once every other runner is busy, and the wait line names why it skips one [C7,#3500]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { cellProject } from '../../../../../store/tests/fixtures/cell.js';
import { runFixtureChildAsync } from '../../../../../gate/tests/fixtures/child.js';

/** Run a body against a real private machine queue; fake runner names exercise admission with no network. */
async function scenario(t, body) {
  const box = cellProject(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1 }));
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[key];
  const source = `import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { takeResource } from ${JSON.stringify(new URL('../../../../index.js', import.meta.url).href)};
import { runnerWaitLine } from ${JSON.stringify(new URL('../../../../src/io/runner/reasons.js', import.meta.url).href)};
import { runnerWaitReasons } from ${JSON.stringify(new URL('../../../../src/io/runner/reasons.js', import.meta.url).href)};
const root = process.cwd();
// The 7 Nov pool in small: two 10-core runners with stale load readings and the 12-core big runner, which auto keeps for most cores.
const stale = { at: '2026-11-06T17:40:52.285Z', busyPercent: 1, average: [3, 3, 3] };
const runners = [
  { host: 'mini-a', slots: 2, browser: 1, gui: true, cores: 10, cpuLoad: stale },
  { host: 'mini-b', slots: 2, browser: 1, gui: true, cores: 10, cpuLoad: stale },
  { host: 'studio-host', slots: 3, browser: 2, gui: true, cores: 12 },
];
const policy = { enabled: false, timingRunner: 'auto' };
const base = { name: 'gate', capacity: 2, scope: 'machine', root, remote: true, runnerOnly: true, runnerProvider: () => runners, runnerLoadPolicyProvider: () => policy };
const leases = [];
const pending = [];
let db;
/** Ask for a lease and record every runner wait line it reports; the caller awaits it or watches it wait. */
function ask(agent, options = {}) {
  const control = { waiting: false, cancel: false, lines: [] };
  const promise = takeResource({ ...base, ...options, agent, item: 'private-' + agent, onWait(state) {
    if (control.cancel) throw new Error('private cancellation');
    if (state.runnerWait) control.lines.push(runnerWaitLine(state.runnerWait));
    control.waiting = true;
  } });
  promise.then(lease => { leases.push(lease); db ??= new DatabaseSync(lease.pool); }, () => {});
  pending.push({ promise, control });
  return { promise, control };
}
/** Take a lease now and keep it until the fixture ends. */
async function hold(agent, options) { const lease = await ask(agent, options).promise; db ??= new DatabaseSync(lease.pool); return lease; }
/** A bounded poll is a hang ceiling for queue state, never a timing measurement. */
async function until(read, label) { const stop = Date.now() + 5000; while (Date.now() < stop) { const value = read(); if (value) return value; await pause(10); } throw new Error('private queue did not reach ' + label); }
/** Count this pool's holders on one runner. */
const on = host => db.prepare('SELECT count(*) AS n FROM holder WHERE name = ?').get('runner:' + host).n;
try { ${body} }
finally { for (const entry of pending) entry.control.cancel = true; for (const lease of leases.reverse()) lease.release(); await Promise.allSettled(pending.map(entry => entry.promise)); db?.close(); }
`;
  const result = await runFixtureChildAsync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 20_000, // budget: only owned fixture children; a queue regression must not hang the suite.
  });
  assert.equal(result.status, 0, `${result.context}\n${result.stdout}\n${result.stderr}`);
}

test('clause 1: with every other runner busy, a queued browser run is admitted to the idle kept runner studio-host [C7]', async t => {
  await scenario(t, `
const first = await hold('browser-1', { browser: true });
const second = await hold('browser-2', { browser: true });
assert.deepEqual([first.runner.host, second.runner.host].sort(), ['mini-a', 'mini-b'], 'the first browser runs fill the other runners');
const kept = db.prepare('SELECT host, reason FROM runner_timing_reserve').get();
assert.deepEqual({ ...kept }, { host: 'studio-host', reason: 'most cores' }, 'auto keeps studio-host for timed checks, as on 7 Nov');
// The hand-off worker logs' waiting state: the others show browser 0 free, studio-host is wholly free with no holder.
const line = runnerWaitLine({ browser: true, gui: false, timing: false, runners: runnerWaitReasons(db, runners, { browser: 1, gui: 0, timing: 0 }, new Set()) });
assert.match(line, /mini-a: busy, gate 1\\/2 free, browser 0\\/1 free/u);
assert.match(line, /mini-b: busy, gate 1\\/2 free, browser 0\\/1 free/u);
assert.match(line, /studio-host: queue priority, gate 3\\/3 free, browser 2\\/2 free, leases none/u);
assert.equal(on('studio-host'), 0, 'no holder on studio-host before the queued run');
const third = await hold('browser-3', { browser: true });
assert.equal(third.runner.host, 'studio-host', 'the queued browser run is admitted to studio-host');
const fourth = await hold('browser-4', { browser: true });
assert.equal(fourth.runner.host, 'studio-host', 'a second queued browser run takes studio-host\\'s other browser slot');
const plain = await hold('plain-1');
assert.ok(['mini-a', 'mini-b'].includes(plain.runner.host), 'an ordinary run still prefers a free slot on another runner over the kept one: ' + plain.runner.host);
assert.equal(on('studio-host'), 2);
`);
});

test('clause 1: a queued gate run waits while a timed check waits, then the timed check gets studio-host once its lent runs end [C7]', async t => {
  await scenario(t, `
for (let n = 0; n < 4; n++) await hold('fill-' + n);
assert.equal(on('mini-a') + on('mini-b'), 4, 'ordinary runs fill every slot on the other runners');
const lent = await hold('lent-1');
assert.equal(lent.runner.host, 'studio-host', 'a queued gate run is admitted to idle studio-host once the others are full');
const timed = ask('timed-1', { timing: true });
await until(() => timed.control.waiting, 'timed check waiting for studio-host to drain');
const queued = ask('queued-1');
await until(() => queued.control.waiting, 'ordinary run waiting while the timed check waits');
assert.equal(on('studio-host'), 1, 'no new ordinary run joins studio-host while a timed check waits');
lent.release();
leases.splice(leases.indexOf(lent), 1);
const timedLease = await timed.promise;
assert.equal(timedLease.runner.host, 'studio-host');
assert.equal(timedLease.timing, true);
`);
});

test('clause 2: the runner wait line names the kept-runner reason for a skipped runner instead of queue priority [C7]', async t => {
  await scenario(t, `
for (let n = 0; n < 4; n++) await hold('fill-' + n);
const lent = await hold('lent-1');
assert.equal(lent.runner.host, 'studio-host');
const timed = ask('timed-1', { timing: true });
await until(() => timed.control.lines.length, 'timed check wait line');
const queued = ask('queued-1', { browser: true });
await until(() => queued.control.lines.length, 'ordinary run wait line');
const ordinaryLine = queued.control.lines.at(-1);
assert.match(ordinaryLine, /studio-host: kept for timed checks \\(a timed check is waiting\\), gate 2\\/3 free, browser 2\\/2 free/u, ordinaryLine);
assert.doesNotMatch(ordinaryLine, /studio-host: queue priority/u, ordinaryLine);
assert.match(ordinaryLine, /mini-a: busy/u);
assert.match(timed.control.lines.at(-1), /mini-a: busy, gate 0\\/2 free/u, 'a full runner stays busy for the timed check');
lent.release();
leases.splice(leases.indexOf(lent), 1);
await timed.promise;
for (const lease of leases.splice(0)) lease.release();
const admitted = await queued.promise;
assert.equal(admitted.runner.host, 'mini-a', 'the waiting browser run starts once a runner frees');
// With a free slot on another runner, the kept runner is skipped for its reservation, not queue priority.
const ordinary = runnerWaitLine({ browser: false, gui: false, timing: false, runners: runnerWaitReasons(db, runners, { browser: 0, gui: 0, timing: 0 }, new Set()) });
assert.match(ordinary, /studio-host: kept for timed checks \\(lent only when every other runner is full\\), gate 3\\/3 free/u, ordinary);
assert.match(ordinary, /mini-b: queue priority/u, ordinary);
// A timed check is told the other runners are not for it, even with their slots free.
const timedWait = runnerWaitLine({ browser: false, gui: false, timing: true, runners: runnerWaitReasons(db, runners, { browser: 0, gui: 0, timing: 1 }, new Set()) });
assert.match(timedWait, /mini-b: unavailable \\(timed checks run only on studio-host, the runner kept for them\\), gate 2\\/2 free/u, timedWait);
assert.match(timedWait, /studio-host: queue priority, gate 3\\/3 free/u, timedWait);
`);
});
