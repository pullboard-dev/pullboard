/** One runner is kept for timed checks: they queue only for it, and every other runner stays whole for ordinary runs [C7]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { gateRunnerLoadPolicy } from '../../index.js';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { runFixtureChildAsync } from '../fixtures/child.js';

/** Run a body against a real private machine queue; fake runner names exercise admission with no network. */
async function scenario(t, body) {
  const box = cellProject(t);
  mkdirSync(box.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  writeFileSync(join(box.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1 }));
  for (const key of ['PULLBOARD_GATE_SLOT_HELD', 'PULLBOARD_GATE_SLOT_POOL', 'PULLBOARD_GATE_SLOT_TOKEN', 'PULLBOARD_BROWSER_SLOT_HELD']) delete box.env[key];
  const source = `import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as pause } from 'node:timers/promises';
import { takeResource } from ${JSON.stringify(new URL('../../../resources/index.js', import.meta.url).href)};
const root = process.cwd();
const at = new Date().toISOString();
// quiet-b has the most measured headroom (16 cores, load 2); the others are busier or smaller.
const runners = [
  { host: 'busy-a', slots: 3, browser: 0, cores: 12, cpuLoad: { at, busyPercent: 80, average: [10, 10, 10] } },
  { host: 'quiet-b', slots: 3, browser: 0, cores: 16, cpuLoad: { at, busyPercent: 10, average: [2, 2, 2] } },
  { host: 'small-c', slots: 3, browser: 0, cores: 4, cpuLoad: { at, busyPercent: 20, average: [1, 1, 1] } },
];
let policy = { enabled: false, timingRunner: 'auto' };
const base = { name: 'gate', capacity: 2, scope: 'machine', root, remote: true, runnerOnly: true, runnerProvider: () => runners, runnerLoadPolicyProvider: () => policy };
const leases = [];
const pending = [];
let db;
/** Take an ordinary lease and keep it until the fixture ends. */
async function ordinary(agent) { const lease = await takeResource({ ...base, agent }); leases.push(lease); db ??= new DatabaseSync(lease.pool); return lease; }
/** Ask for a timed lease; the caller awaits it or watches it wait. */
function timed(agent, options = {}) {
  const control = { waiting: false, cancel: false };
  const promise = takeResource({ ...base, ...options, timing: true, agent, item: 'private-' + agent, onWait() { if (control.cancel) throw new Error('private cancellation'); control.waiting = true; } });
  promise.then(lease => leases.push(lease), () => {});
  pending.push({ promise, control });
  return { promise, control };
}
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

test('a timed check runs on the runner kept by measured headroom while ordinary runs keep every slot on the others [C7]', async t => {
  await scenario(t, `
const hosts = [];
for (let n = 0; n < 6; n++) hosts.push((await ordinary('ordinary-' + n)).runner.host);
assert.ok(!hosts.includes('quiet-b'), 'ordinary runs never take the kept runner: ' + hosts.join(','));
assert.equal(on('busy-a') + on('small-c'), 6, 'ordinary runs fill all six slots on the other runners');
const kept = db.prepare('SELECT host, reason FROM runner_timing_reserve').get();
assert.equal(kept.host, 'quiet-b', 'the runner with the most measured headroom is kept');
assert.match(kept.reason, /measured headroom/u);
const lease = await timed('timed-one').promise;
assert.equal(lease.runner.host, 'quiet-b');
assert.equal(lease.timing, true, 'the timed check holds its runner alone');
assert.equal(on('busy-a') + on('small-c'), 6, 'no ordinary run was drained or moved for the timed check');
assert.equal(db.prepare('SELECT count(*) AS n FROM runner_timing_drain').get().n, 0, 'no runner is drained');
assert.equal(db.prepare("SELECT count(*) AS n FROM runner_timing_event WHERE kind = 'drain-start'").get().n, 0);
`);
});

test('with the kept runner busy, timed checks queue for it and ordinary runs are unaffected [C7]', async t => {
  await scenario(t, `
const first = await timed('timed-first').promise;
db ??= new DatabaseSync(first.pool);
assert.equal(first.runner.host, 'quiet-b');
const second = timed('timed-second');
await until(() => second.control.waiting, 'second timed check waiting');
const hosts = [];
for (let n = 0; n < 6; n++) hosts.push((await ordinary('ordinary-' + n)).runner.host);
assert.ok(!hosts.includes('quiet-b'), 'ordinary runs still get every slot on the other runners while a timed check waits');
assert.equal(db.prepare('SELECT count(*) AS n FROM runner_timing_drain').get().n, 0, 'a waiting timed check drains nothing');
first.release();
leases.splice(leases.indexOf(first), 1);
const next = await second.promise;
assert.equal(next.runner.host, 'quiet-b', 'the queued timed check takes the kept runner when it frees');
assert.equal(on('busy-a') + on('small-c'), 6, 'ordinary runs were never disturbed');
`);
});

test('a configured runner is kept, and false returns to the drain rule [C7]', async t => {
  await scenario(t, `
policy = { enabled: false, timingRunner: 'small-c' };
const lease = await timed('timed-configured').promise;
db ??= new DatabaseSync(lease.pool);
assert.equal(lease.runner.host, 'small-c', 'the configured runner is the kept one');
assert.equal(db.prepare('SELECT host, reason FROM runner_timing_reserve').get().reason, 'configured');
lease.release();
leases.splice(leases.indexOf(lease), 1);
policy = { enabled: false, timingRunner: false };
const plain = await ordinary('ordinary-after-off');
assert.ok(plain.runner.host, 'ordinary work is admitted');
assert.equal(db.prepare('SELECT count(*) AS n FROM runner_timing_reserve').get().n, 0, 'off keeps no runner');
`);
});

test('a timed check off the runner-only path still waits for the kept runner, never the local slot [C7]', async t => {
  await scenario(t, `
const lease = await timed('timed-default', { runnerOnly: false }).promise;
db ??= new DatabaseSync(lease.pool);
assert.equal(lease.runner?.host, 'quiet-b', 'a timed gate with a free local slot still runs on the kept runner');
const second = timed('timed-default-2', { runnerOnly: false });
await until(() => second.control.waiting, 'second default timed check waiting');
assert.equal(db.prepare("SELECT count(*) AS n FROM holder WHERE name = 'gate'").get().n, 0, 'no timed check took the local slot');
lease.release();
leases.splice(leases.indexOf(lease), 1);
assert.equal((await second.promise).runner?.host, 'quiet-b');
`);
});

test('a host restriction that cannot meet the kept runner is refused, and one that can is honoured [C7]', async t => {
  await scenario(t, `
await assert.rejects(takeResource({ ...base, timing: true, agent: 'timed-elsewhere', requiredExecutor: { kind: 'ssh', host: 'busy-a' } }),
  error => error.code === 'TIMING_RUNNER_RESTRICTION' && /quiet-b/u.test(error.message), 'a timed check restricted away from the kept runner is refused');
await assert.rejects(takeResource({ ...base, agent: 'ordinary-kept-only', requiredExecutor: { kind: 'ssh', host: 'quiet-b' } }),
  error => error.code === 'TIMING_RUNNER_RESTRICTION', 'an ordinary run restricted to the kept runner alone is refused');
const lease = await takeResource({ ...base, agent: 'ordinary-either', requiredExecutor: { kind: 'ssh', host: 'quiet-b', hosts: ['quiet-b', 'small-c'] } });
leases.push(lease);
assert.equal(lease.runner.host, 'small-c', 'an ordinary run that may use another runner goes there, never to the kept one');
const timedLease = await takeResource({ ...base, timing: true, agent: 'timed-kept', requiredExecutor: { kind: 'ssh', host: 'quiet-b', hosts: ['quiet-b', 'busy-a'] } });
leases.push(timedLease);
assert.equal(timedLease.runner.host, 'quiet-b', 'a timed check whose restriction includes the kept runner runs there');
`);
});

test('the gate keeps a runner by default and the setting names one or turns it off [C7]', () => {
  assert.equal(gateRunnerLoadPolicy({}).timingRunner, 'auto');
  assert.equal(gateRunnerLoadPolicy({ gate: { timingRunner: 'runner-7' } }).timingRunner, 'runner-7');
  assert.equal(gateRunnerLoadPolicy({ gate: { timingRunner: false } }).timingRunner, false);
});


test('reserved timed checks keep queueing past ordinary runner deadlines with free local and other runner slots [C7]', async t => {
  await scenario(t, `
let first = await timed('deadline-first').promise;
db ??= new DatabaseSync(first.pool);
for (const runnerOnly of [false, true]) {
  const next = timed('deadline-next-' + runnerOnly, { runnerOnly, runnerWaitMs: 1 });
  let settled = false;
  next.promise.then(() => { settled = true; }, () => { settled = true; });
  await until(() => next.control.waiting, 'reserved timed waiter');
  await pause(100);
  assert.equal(settled, false, 'ordinary expiry neither rejects nor falls back locally');
  assert.equal(on('busy-a') + on('small-c'), 0, 'other runners remain untouched');
  assert.equal(db.prepare("SELECT count(*) AS n FROM holder WHERE name = 'gate'").get().n, 0, 'local slot remains free');
  first.release();
  const admitted = await next.promise;
  assert.equal(admitted.runner.host, 'quiet-b');
  admitted.release();
  if (!runnerOnly) {
    first = await timed('deadline-replacement').promise;
  }
}
`);
});

test('a reserved timed check explicitly refuses a local-only executor [C7]', async t => {
  await scenario(t, `
await assert.rejects(takeResource({ ...base, runnerOnly: false, timing: true, agent: 'timed-local', requiredExecutor: { kind: 'local' } }),
  error => error.code === 'TIMING_RUNNER_RESTRICTION', 'local execution cannot satisfy the reserved runner');
`);
});
