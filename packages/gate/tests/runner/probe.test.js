/** @pullboard-test-input packages/config/index.js packages/gate/index.js packages/gate/src/io/shards/proof.js packages/landing/index.js packages/runners/index.js */
/** A missed runner admission deadline quarantines a runner only when its confirming probe fails too (#3738) [C7]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { cellProject } from '../../../store/tests/fixtures/cell.js';
import { runFixtureChild } from '../fixtures/child.js';

const SOURCE = join(import.meta.dirname, '../../../..');
const RUNNER = 'only-runner';
const cleanups = [];
after(() => { for (const cleanup of cleanups.reverse()) cleanup(); });
/** The module-level owner of each cell project's cleanup, for helpers that run outside a test context. */
const owner = { after: cleanup => cleanups.push(cleanup) };

/**
 * Drive the real gate slot, SQLite queue and runner recovery tables with one configured runner (or none), where
 * the runner's job misses its admission deadline `drops` times. Why: on 8 Nov a coordinator at load 25 missed every
 * deadline and quarantined six idle runners; only the controller's clock was slow, so the probe ports answer here.
 */
function deadline({ runners = 1, gateSlots = 0, drops = 1, answers = true } = {}) {
  const box = cellProject(owner, { real: true, gate: 'true' });
  const root = box.repo;
  const env = box.env;
  const url = cell => JSON.stringify(pathToFileURL(join(SOURCE, 'packages', cell, 'index.js')).href);
  const marker = join(box.dir, 'local-body');
  const script = `import { withGateSlot, RunnerDropped } from ${url('gate')};
import { runnerExecutionServices } from ${url('runners')};
import { landingExecutionServices } from ${url('landing')};
import { listResources } from ${url('resources')};
import { addRunner } from ${url('config')};
import { setBrowserSlots } from ${url('config')};
import { setGateRunnerWaitMs } from ${url('config')};
import { setGateRunnersFirst } from ${url('config')};
import { setGateSlots } from ${url('config')};
import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Declare the machine through the canonical settings writers: browser slots fall before gate slots may reach 0.
if (${JSON.stringify(runners)}) addRunner({ host: ${JSON.stringify(RUNNER)}, slots: 1, browser: 1 });
if (${JSON.stringify(gateSlots)} === 0) setBrowserSlots(0);
setGateSlots(${JSON.stringify(gateSlots)});
setGateRunnersFirst(true);
setGateRunnerWaitMs(100);
let probes = 0;
const executionServices = { runners: { ...runnerExecutionServices(),
  probeRunnerTransport: async () => { probes += 1; return { healthy: ${JSON.stringify(answers)} }; },
  probeRunnerHealth: async () => ({ healthy: false }),
  refreshRunnerMeasurements: async () => {} }, landing: landingExecutionServices() };
const attempts = [], waits = [];
let result, failure, dropped = 0;
try { result = await withGateSlot(process.cwd(), async lease => {
  const host = lease.runner?.host ?? 'local';
  attempts.push(host);
  if (host === 'local') { writeFileSync(${JSON.stringify(marker)}, 'ran'); return host; }
  if (dropped < ${JSON.stringify(drops)}) { dropped += 1; throw new RunnerDropped(host, { reason: 'admission-deadline', phase: 'connect' }); }
  return host;
}, { executionServices, onWait: state => { if (state.runnerUnavailable) waits.push(state.runnerUnavailable); } });
} catch (error) { failure = { code: error.code, message: error.message }; }
/** Read a recovery table the gate created, or nothing when no runner ever reached recovery. */
const rows = sql => { const db = new DatabaseSync(join(process.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'));
  try { return db.prepare(sql).all().map(row => ({ ...row })); } catch { return []; } finally { db.close(); } };
process.stdout.write(JSON.stringify({ result, failure, attempts, probes, waits: waits.map(wait => ({ reason: wait.reason, until: wait.until,
  probe: wait.diagnostic?.confirmingProbe?.healthy ?? null })),
  unavailable: rows('SELECT host, detail, failure FROM runner_unavailable'),
  events: rows("SELECT kind, detail FROM runner_recovery_event WHERE kind = 'unavailable'"),
  holders: listResources({ scope: 'machine' }).flatMap(row => row.holders) }));`;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root, env, encoding: 'utf8', timeout: 30_000,
  }); // budget: private queue admission, one load-tolerant probe with three 1 s retry pauses, and the declared deadline.
  assert.equal(child.status, 0, child.context ?? child.stderr);
  return { ...JSON.parse(child.stdout), localRan: existsSync(marker) };
}

/**
 * Drive the real gate slot with one runner slot held past the queue wait, so the second request is admitted late, and
 * report that lease's startup budget. `lane` takes the second request's options from the proof batch lane builder.
 * Why: the budget used to copy the queue wait setting, so a 30 s lane window became a 30 s startup budget (#3832).
 */
function lateBudget({ lane = false, waitMs = 100 } = {}) {
  const box = cellProject(owner, { real: true, gate: 'true' });
  const url = path => JSON.stringify(pathToFileURL(join(SOURCE, path)).href);
  const script = `import { withGateSlot } from ${url('packages/gate/index.js')};
import { shardSlotOptions } from ${url('packages/gate/src/io/shards/proof.js')};
import { runnerExecutionServices } from ${url('packages/runners/index.js')};
import { landingExecutionServices } from ${url('packages/landing/index.js')};
import { addRunner, setBrowserSlots, setGateRunnersFirst, setGateSlots } from ${url('packages/config/index.js')};
addRunner({ host: ${JSON.stringify(RUNNER)}, slots: 1, browser: 1 });
setBrowserSlots(0); setGateSlots(0); setGateRunnersFirst(true);
const executionServices = { runners: { ...runnerExecutionServices(), probeRunnerTransport: async () => ({ healthy: true }),
  probeRunnerHealth: async () => ({ healthy: true }), refreshRunnerMeasurements: async () => {} }, landing: landingExecutionServices() };
let late = null, release;
const held = new Promise(done => { release = done; });
let taken; const gotFirst = new Promise(done => { taken = done; });
const first = withGateSlot(process.cwd(), async () => { taken(); await held; }, { executionServices, runnerOnly: true, runnerWaitMs: 5_000 });
await gotFirst;
const options = ${lane ? `shardSlotOptions({ executionServices }, { admitMs: ${JSON.stringify(waitMs)} })` : `{ executionServices, runnerOnly: true, runnerWaitMs: ${JSON.stringify(waitMs)} }`};
let waited = false;
const second = withGateSlot(process.cwd(), async lease => { late = lease.lateRunnerDispatch ?? null; }, { ...options, executionServices,
  onWait: async state => { if (state.admitted || waited) return; waited = true;
    await new Promise(done => setTimeout(done, ${JSON.stringify(waitMs)} + 100)); release(); } });
await Promise.all([first, second]);
process.stdout.write(JSON.stringify({ late }));`;
  const child = runFixtureChild(process.execPath, ['--input-type=module', '-e', script], {
    cwd: box.repo, env: box.env, encoding: 'utf8', timeout: 30_000,
  }); // budget: private queue admission of two leases and one 200 ms queue wait.
  assert.equal(child.status, 0, child.context ?? child.stderr);
  return JSON.parse(child.stdout).late;
}

test('clause 1: a lease admitted after its queue deadline gets the fixed 90 s startup budget, whatever runnerWaitMs says [C7]', () => {
  const late = lateBudget({ waitMs: 100 });
  assert.ok(late, 'the second request was admitted late');
  assert.equal(late.budgetMs, 90_000);
  assert.equal(late.startupDeadlineAt - late.admittedAt, 90_000);
});

test('clause 2: a proof batch lane admission window does not set its startup budget [C7]', () => {
  const late = lateBudget({ lane: true, waitMs: 100 });
  assert.ok(late, 'the lane request was admitted late');
  assert.equal(late.budgetMs, 90_000, 'the lane gets the same startup budget as a submit lease');
  assert.notEqual(late.budgetMs, 100);
});

test('clause 1, clause 3, clause 4: with one runner, a coordinator-side slowdown that misses the deadline leaves that runner in service [C7]', () => {
  const run = deadline();
  assert.equal(run.failure, undefined, JSON.stringify(run.failure));
  assert.equal(run.probes, 1, 'the missed deadline ran the same load-tolerant confirming probe');
  assert.equal(run.waits[0].probe, true, 'the requeue names the answering probe');
  assert.match(run.waits[0].reason, /admission deadline; confirming SSH and Node observation succeeded/u);
  assert.equal(run.waits[0].until, 'the original ticket is readmitted');
  assert.deepEqual(run.unavailable, [], 'the answering runner is never quarantined');
  assert.deepEqual(run.events, [], 'no unavailable event, so no readiness recurrence hold can build on a healthy runner');
  assert.deepEqual(run.attempts, [RUNNER, RUNNER], 'only the job was requeued, onto the same runner');
  assert.equal(run.result, RUNNER);
  assert.equal(run.localRan, false);
  assert.equal(run.holders.length, 0);
});

test('clause 1, clause 4: an answering runner that misses its deadline again refuses only the job as a wait-deadline failure [C7]', () => {
  const run = deadline({ drops: 2 });
  assert.equal(run.failure?.code, 'RUNNER_WAIT_DEADLINE');
  assert.match(run.failure.message, /only-runner answers SSH and Node but missed its admission deadline again/u);
  assert.deepEqual(run.attempts, [RUNNER, RUNNER]);
  assert.equal(run.probes, 2, 'each missed deadline was confirmed by the probe');
  assert.deepEqual(run.unavailable, [], 'the refused job leaves the runner in service');
  assert.deepEqual(run.events, []);
  assert.equal(run.holders.length, 0);
});

test('clause 2, clause 3: a runner whose confirming probe fails after a missed deadline is still quarantined [C7]', () => {
  const run = deadline({ gateSlots: 1, drops: 99, answers: false });
  assert.equal(run.probes, 4, 'the probe and its three retries all failed first');
  assert.equal(run.waits[0].probe, false);
  assert.equal(run.waits[0].reason, 'worker did not become ready before its admission deadline', 'the existing reason is kept');
  assert.deepEqual(run.unavailable.map(row => [row.host, row.detail]), [[RUNNER, 'WORKER_UNRESPONSIVE']], 'the existing code is kept');
  assert.equal(JSON.parse(run.unavailable[0].failure).original.confirmingProbe.attempts.length, 4, 'the quarantine names every probe attempt');
  assert.deepEqual(run.attempts.filter(host => host === RUNNER), [RUNNER], 'the quarantined runner is not dispatched again');
  assert.equal(run.result, 'local');
  assert.equal(run.localRan, true);
  assert.equal(run.holders.length, 0);
});

test('clause 4: without runners the run executes locally and no probe or quarantine exists [C7]', () => {
  const run = deadline({ runners: 0, gateSlots: 1 });
  assert.equal(run.failure, undefined, JSON.stringify(run.failure));
  assert.equal(run.result, 'local');
  assert.deepEqual(run.attempts, ['local']);
  assert.equal(run.probes, 0);
  assert.deepEqual(run.unavailable, []);
  assert.equal(run.holders.length, 0);
});
