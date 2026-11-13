/** Real private admission uses runner-owned CPU observations without changing fleet capacity [C7,Q1,O5]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { takeResource } from '../../../../packages/resources/index.js';
import { loadMachineSettings } from '../../../../packages/config/index.js';
import { validateRunner } from '../../../../packages/config/index.js';
import { refreshRunnerMeasurements } from '../../../../packages/runners/index.js';
import { probeRunnerTransport } from '../../../../packages/runners/index.js';
import { healthReport } from '../../../../packages/health/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { installSshStandIn } from '../../tests/fixtures/runner/ssh.js';
import { HOST } from '../../tests/fixtures/runner/ssh.js';

/** Scope actual machine admission and all child transports to disposable fixture storage. */
function box(t) {
  const helpers = createE2eHelpers();
  const project = helpers.project('true');
  mkdirSync(project.env.PULLBOARD_MACHINE_HOME, { recursive: true });
  const keys = ['PULLBOARD_HOME', 'PULLBOARD_MACHINE_HOME', 'PATH'];
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  for (const key of keys) process.env[key] = project.env[key];
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    helpers.cleanup();
  });
  return project;
}

/** Publish a fixture runner's actual observation shape, with no controller-local CPU inference. */
function runner(host, busyPercent, at = new Date().toISOString()) {
  return { host, slots: 2, browser: 1, gui: true, cpuLoad: { at, busyPercent, average: [2, 3, 4] } };
}

/** Acquire a real SQLite resource lease with all normal capability and durable queue guards. */
function acquire(project, runners, policy = { enabled: true, ceiling: 90 }, extra = {}) {
  return takeResource({ name: 'gate', capacity: 1, browserCapacityProvider: () => 1,
    scope: 'machine', root: project.repo, agent: 'fixture-load-dispatch', remote: true, runnerOnly: true,
    runnerProvider: () => runners, runnerLoadPolicyProvider: () => policy, ...extra });
}

test('fresh 30 percent runner wins over a free 95 percent runner in actual admission [C7,Q1]', async t => {
  const project = box(t);
  const lease = await acquire(project, [runner('busy-host', 95), runner('quiet-host', 30)]);
  try {
    assert.equal(lease.runner.host, 'quiet-host');
    assert.equal(lease.runner.dispatch.busyPercent, 30);
  } finally { lease.release(); }
});

test('all runners over the ceiling fall back to free slots and say so [C7,Q1]', async t => {
  const project = box(t);
  const runners = [runner('first-host', 95), runner('second-host', 96)];
  const held = await acquire(project, runners, { enabled: false });
  let lease;
  try {
    assert.equal(held.runner.host, 'first-host');
    lease = await acquire(project, runners);
    assert.equal(lease.runner.host, 'second-host', 'the unused runner has more free slots');
    assert.match(lease.runner.dispatch.reason, /all compatible runners.*falling back to free slots/u);
  } finally { lease?.release(); held.release(); }
});

test('off, stale and future readings preserve admission instead of inventing idle capacity [C7,Q1,O5]', async t => {
  const project = box(t);
  for (const [runners, policy] of [
    [[runner('first-host', 95), runner('second-host', 30)], { enabled: false }],
    [[runner('first-host', 95, new Date(Date.now() - 60_000).toISOString()), runner('second-host', 30, new Date(Date.now() - 60_000).toISOString())], { enabled: true }],
    [[runner('first-host', 95, new Date(Date.now() + 60_000).toISOString()), runner('second-host', 30, new Date(Date.now() + 60_000).toISOString())], { enabled: true }],
  ]) {
    const lease = await acquire(project, runners, policy);
    try {
      assert.equal(lease.runner.host, 'first-host');
      if (policy.enabled) assert.match(lease.runner.dispatch.reason, /missing or stale/u);
      else assert.equal(lease.runner.dispatch, undefined);
    } finally { lease.release(); }
  }
});

test('CPU preference cannot bypass the required host or browser capability [C7,Q1]', async t => {
  const project = box(t);
  const runners = [runner('busy-host', 95), { ...runner('quiet-host', 30), browser: 0 }];
  for (const extra of [{ requiredExecutor: { kind: 'ssh', host: 'busy-host' } }, { browser: true }]) {
    const lease = await acquire(project, runners, undefined, extra);
    try { assert.equal(lease.runner.host, 'busy-host'); } finally { lease.release(); }
  }
});

test('settings default off, validate percentages and health names only fresh runner readings [C7,O5]', t => {
  const project = box(t);
  assert.equal(loadMachineSettings().gate?.loadAwareDispatch, undefined);
  const file = join(project.env.PULLBOARD_MACHINE_HOME, 'settings.json');
  for (const gate of [{ loadAwareDispatch: 'yes' }, { runnerBusyCeiling: 101 }]) {
    writeFileSync(file, JSON.stringify({ gateSlots: 1, browserSlots: 1, gate }));
    assert.throws(loadMachineSettings, { code: 'BAD_MACHINE_SETTINGS' });
  }
  assert.throws(() => validateRunner(runner('bad-host', -1)), { code: 'BAD_RUNNER' });
  writeFileSync(file, JSON.stringify({ gateSlots: 1, browserSlots: 1, gate: { loadAwareDispatch: true },
    runners: [runner('busy-host', 95), runner('quiet-host', 30), runner('stale-host', 0, new Date(Date.now() - 60_000).toISOString())] }));
  assert.equal(healthReport({ db: null, root: project.repo, now: new Date() }).runnerCpu, undefined, 'omitted data port cannot invent runner observations');
  const report = healthReport({ db: null, root: project.repo, now: new Date(), machineSettings: loadMachineSettings() });
  assert.equal(report.runnerCpu.spread, 65);
  assert.deepEqual(report.runnerCpu.readings.map(row => row.host), ['busy-host', 'quiet-host']);
  assert.ok(report.stuck.some(row => row.cause === 'RUNNER_CPU_SPREAD'));
  const command = project.run(project.repo, 'health', '--json');
  const actual = JSON.parse(command.out);
  assert.equal(actual.runnerCpu.spread, 65, 'the real CLI binds its validated machine-settings snapshot');
});

test('existing nonce health transport measures remote CPU counters and refresh forwards only runner observations [C7,O5]', async t => {
  const project = box(t);
  const paths = Object.fromEntries(['bin', 'worker', 'remoteHome', 'remoteMachine'].map(name => [name, join(project.dir, name)]));
  for (const path of Object.values(paths)) mkdirSync(path, { recursive: true });
  const preload = join(project.dir, 'remote-cpu.cjs');
  writeFileSync(preload, "const os=require('node:os');let call=0;os.cpus=()=>[{times:{user:call++?70:0,idle:call>1?30:0}}];os.loadavg=()=>[7,8,9];\n");
  installSshStandIn({ ...paths, home: paths.remoteHome, machineHome: paths.remoteMachine,
    requests: join(project.dir, 'requests.jsonl'), registrationNodeOptions: `--require=${preload}` });
  process.env.PATH = `${paths.bin}:${process.env.PATH}`;
  const observed = await probeRunnerTransport({ host: HOST, slots: 2, browser: 1 }, { observeGui: true, observeLoad: true });
  assert.equal(observed.healthy, true);
  assert.equal(observed.cpuLoad.busyPercent, 70);
  assert.deepEqual(observed.cpuLoad.average, [7, 8, 9]);
  const records = [];
  await refreshRunnerMeasurements({ gate: { loadAwareDispatch: true }, runners: [{ host: HOST }] }, {
    measure: async (destination, options) => { assert.equal(destination.host, HOST); assert.equal(options.observeLoad, true); return observed; },
    record: (host, sample) => records.push({ host, sample }),
  });
  assert.equal(records[0].sample.cpuLoad, observed.cpuLoad);
  const rejected = [];
  await refreshRunnerMeasurements({ gate: { loadAwareDispatch: true }, runners: [{ host: HOST }] }, {
    measure: async () => ({ ...observed, healthy: false }), record: (...args) => rejected.push(args),
  });
  assert.deepEqual(rejected, [], 'failed nonce transport cannot publish telemetry');
});
