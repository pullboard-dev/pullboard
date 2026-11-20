/** Runner admission sends each job to the runner with the most live headroom and queues when all are overloaded [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { takeResource } from '../../resources/index.js';
import { recordRunnerMeasurement } from '../../config/index.js';
import { loadMachineSettings } from '../../config/index.js';
import { gateRunnerLoadPolicy } from '../../gate/heavy.js';
import { refreshRunnerMeasurements } from '../index.js';
import { cellProject } from '../../store/tests/fixtures/cell.js';

/** Scope real machine admission to disposable fixture storage. */
function box(t) {
  const project = cellProject(t, { gate: 'true' });
  mkdirSync(project.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const keys = ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PATH'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = project.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  return project;
}

/** A 10-core runner with 9 slots whose own fresh reading shows this 1-minute load. */
function runner(host, load, at = new Date().toISOString()) {
  return { host, slots: 9, browser: 6, gui: true, cores: 10, cpuLoad: { at, busyPercent: Math.min(100, load * 10), average: [load, load, load] } };
}

/** Acquire a real SQLite runner lease under load-aware dispatch. */
function acquire(project, runners, extra = {}) {
  return takeResource({ name: 'gate', capacity: 1, browserCapacityProvider: () => 1,
    scope: 'machine', root: project.repo, agent: 'fixture-least-loaded', remote: true, runnerOnly: true,
    runnerProvider: () => runners, runnerLoadPolicyProvider: () => ({ enabled: true, ceiling: 90 }), ...extra });
}

test('runners.loaded.a-job-goes-to-the-idle: a job goes to the idle runner, never the one at 10x its cores [C7]', async t => {
  const project = box(t);
  const lease = await acquire(project, [runner('overloaded-host', 108), runner('idle-host', 1.4)]);
  try {
    assert.equal(lease.runner.host, 'idle-host');
    assert.equal(lease.runner.dispatch.reason, 'most headroom by runner-reported 1-minute load');
    assert.deepEqual(lease.runner.dispatch.skipped, ['overloaded-host']);
  } finally { lease.release(); }
});

test('runners.loaded.with-two-runners-free-the-lower: with two runners free, the lower load per core wins even with less headroom in cores [C7,#5578]', async t => {
  const project = box(t);
  const small = { ...runner('four-core', 1), cores: 4 };
  const big = runner('ten-core', 4);
  const lease = await acquire(project, [small, big]);
  try {
    assert.equal(lease.runner.host, 'four-core', '1 of 4 cores is 0.25 per core, below 4 of 10 at 0.4, though 10 cores leave more headroom');
  } finally { lease.release(); }
});

test('runners.loaded.the-2-nov-loads-the-runner: the 2 Nov loads: the runner with the most headroom wins and the overloaded one is skipped [C7]', async t => {
  const project = box(t);
  const loads = { '.56': 108, '.52': 16, '.53': 13, '.55': 4.9, '.54': 1.9, '.51': 1.4 };
  const lease = await acquire(project, Object.entries(loads).map(([host, load]) => runner(host, load)));
  try {
    assert.equal(lease.runner.host, '.51');
    assert.deepEqual(lease.runner.dispatch.skipped, ['.56', '.52']);
  } finally { lease.release(); }
});

test('runners.loaded.jobs-admitted-after-a-reading-count: jobs admitted after a reading count as load, so back-to-back jobs spread [C7]', async t => {
  const project = box(t);
  const runners = [runner('first-host', 1), runner('second-host', 1.5)];
  const first = await acquire(project, runners);
  const second = await acquire(project, runners);
  try {
    assert.equal(first.runner.host, 'first-host');
    assert.equal(second.runner.host, 'second-host', 'first-host now carries one job its load average cannot show yet');
  } finally { second.release(); first.release(); }
});

test('runners.loaded.an-overloaded-only-pool-queues-the: an overloaded-only pool queues the job instead of failing it, then admits it once a runner has headroom [C7]', async t => {
  const project = box(t);
  const runners = [runner('first-host', 40), runner('second-host', 16)];
  let waited;
  const queued = new Promise(resolve => { waited = resolve; });
  const pending = acquire(project, runners, { runnerWaitMs: 60_000, onWait: state => { if (!state.admitted) waited(state); } });
  let settled = false;
  pending.then(() => { settled = true; }, () => { settled = true; });
  const state = await queued;
  assert.equal(settled, false, 'the job waits in the queue; nothing is refused');
  assert.equal(state.admitted, undefined);
  runners[1] = runner('second-host', 3);
  const lease = await pending;
  try { assert.equal(lease.runner.host, 'second-host'); } finally { lease.release(); }
});

test('runners.loaded.an-overloaded-reading-keeps-its-runner: an overloaded reading keeps its runner skipped after it goes stale; an old one does not [C7]', async t => {
  const project = box(t);
  const ago = ms => new Date(Date.now() - ms).toISOString();
  let lease = await acquire(project, [runner('stale-overloaded', 50, ago(120_000)), runner('unread-host', 0, ago(600_000))]);
  try { assert.equal(lease.runner.host, 'unread-host'); } finally { lease.release(); }
  lease = await acquire(project, [runner('long-ago-overloaded', 50, ago(600_000))]);
  try { assert.equal(lease.runner.host, 'long-ago-overloaded', 'a reading past the hold is unknown, not overloaded'); } finally { lease.release(); }
});

test('runners.loaded.a-runner-with-a-recent-cleanup: a runner with a recent cleanup timeout is skipped while a healthy runner is free [C7]', async t => {
  const project = box(t);
  const runners = [runner('failing-host', 1), runner('healthy-host', 3)];
  const warm = await acquire(project, runners);
  warm.release();
  const db = new DatabaseSync(join(project.env.PULLBOARD_MACHINE_HOME, 'resources.sqlite'));
  try {
    db.prepare('INSERT INTO runner_recovery_event VALUES(?,?,?,?,?)').run('fixture-event', 'failing-host', new Date().toISOString(), 'unavailable', JSON.stringify({ reason: 'cleanup-unverified' }));
  } finally { db.close(); }
  let lease = await acquire(project, runners);
  try { assert.equal(lease.runner.host, 'healthy-host'); } finally { lease.release(); }
  lease = await acquire(project, [runner('failing-host', 1)]);
  try {
    assert.equal(lease.runner.host, 'failing-host', 'with no healthy runner free it still runs rather than strands');
    assert.equal(lease.runner.dispatch.troubled, undefined);
  } finally { lease.release(); }
});

test('runners.loaded.a-busy-runner-records-its-live: a busy runner records its live load reading instead of being refused as busy [C7]', async t => {
  const project = box(t);
  const file = join(project.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  const registered = { host: 'busy-host', slots: 9, browser: 6, gui: true, cores: 10, memoryMB: 16384 };
  writeFileSync(file, JSON.stringify({ gateSlots: 1, browserSlots: 1, gate: { loadAwareDispatch: true }, runners: [registered] }));
  const lease = await acquire(project, [runner('busy-host', 2)]);
  try {
    const cpuLoad = { at: new Date().toISOString(), busyPercent: 100, average: [42, 30, 20] };
    recordRunnerMeasurement('busy-host', { cores: 12, memoryMB: 8192, measuredAt: new Date().toISOString(), gui: true, cpuLoad });
    const stored = loadMachineSettings().runners[0];
    assert.deepEqual(stored.cpuLoad, cpuLoad);
    assert.equal(stored.cores, 10, 'a busy runner keeps its size so its slots never shrink under admitted jobs');
  } finally { lease.release(); }
});

test('runners.loaded.a-measured-fleet-with-default-settings: a measured fleet with default settings dispatches by live load, measured before admission; only an explicit off disables it [C7]', async t => {
  const project = box(t);
  const measured = { host: 'unread-host', slots: 9, browser: 6, cores: 10, memoryMB: 16384 };
  writeFileSync(join(project.env.PULLBOARD_MACHINE_HOME, 'settings.json'), JSON.stringify({ gateSlots: 1, browserSlots: 1, gate: { timingRunner: false }, runners: [measured] }));
  // Two runners: timingRunner 'auto' would keep the idle one for timed checks (#2512) and hide the load-aware pick under test.
  const settings = loadMachineSettings();
  assert.equal(settings.gate?.loadAwareDispatch, undefined, 'nothing is configured');
  assert.equal(gateRunnerLoadPolicy(settings).enabled, true, 'a measured fleet balances by load by default');
  assert.equal(gateRunnerLoadPolicy({ ...settings, gate: { loadAwareDispatch: false } }).enabled, false);
  assert.equal(gateRunnerLoadPolicy({ runners: [{ host: 'unmeasured', slots: 1, browser: 0 }] }).enabled, false, 'no cores, no 1.5x-cores rule');
  const lease = await acquire(project, [runner('overloaded-host', 108), runner('idle-host', 1.4)],
    { runnerLoadPolicyProvider: () => gateRunnerLoadPolicy(loadMachineSettings()) });
  try { assert.equal(lease.runner.host, 'idle-host'); } finally { lease.release(); }
  const probes = [];
  await refreshRunnerMeasurements(settings, {
    measure: async (destination, options) => { probes.push(options); return { healthy: false }; }, record: () => {},
  });
  assert.equal(probes[0]?.observeLoad, true, 'the gate reads live load before admission under default settings');
});
