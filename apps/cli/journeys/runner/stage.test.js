/** The requested stats window reports measured runner capacity from private Git/SQLite state [C7,O5]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { openBoard } from '../../../lib/index.js';
import { main } from '../../tests/fixtures/native.js';
import { localRunnerDescriptor } from '../../../../packages/runners/index.js';
import { recordReceipt } from '../../../../packages/gate/index.js';
import * as runnerApi from '../../../../packages/runners/index.js';
import { runFixtureGit } from '../../tests/fixtures/child.js';
import { takeResource } from '../../../../packages/resources/index.js';
import { readRunnerStage } from '../../../runner/index.js';

/** Capture the actual CLI response while supplying a deterministic observation clock. */
async function run(root, args, clock) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { cwd: root, clock,
    stdout: { isTTY: false, write: text => { stdout += text; } },
    stderr: { write: text => { stderr += text; } } });
  return { code, stdout, stderr, data: args.includes('--json') ? JSON.parse(stdout) : null };
}

test('[C7,O5] stats --window includes measured runner capacity and slot-wait quartiles from private receipts', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-runner-stage-')));
  const machineHome = join(root, 'machine');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  writeFileSync(join(root, 'pullboard.json'), JSON.stringify({ lanes: { web: { owns: ['web/'] } } }));
  const now = Date.parse('2026-10-24T12:00:00.000Z');
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'), { now: () => new Date(now) });
  t.after(() => store.closeBoard(board));

  const priorMachineHome = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  try {
    mkdirSync(machineHome, { recursive: true });
    writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1 }));
    const runner = { ...localRunnerDescriptor(2, true), active: 0 };
    const admittedAt = new Date(now - 10_000).toISOString();
    const finishedAt = new Date(now - 9_000).toISOString();
    recordReceipt(root, { at: finishedAt, kind: 'check', waitMs: 50, runMs: 500,
      admissionMs: 1, setupMs: 2, evidenceMs: 3, slot: { kind: 'ordinary' },
      runner, admittedAt, finishedAt, timing: false, inherited: false, occupiedSlots: 1,
      exclusive: false, unfencedClients: [] });

    const output = await run(root, ['stats', '--window', '1h', '--json'], { now: () => new Date(now) });
    assert.equal(output.code, 0, output.stderr);
    const capacity = output.data.window.executionCapacity;
    const local = capacity.runners.find(row => row.id === runner.id);
    assert.ok(local, 'the real machine resource snapshot includes the local executor');
    assert.equal(local.runsServed, 1);
    assert.ok(local.busyShare > 0 && local.busyShare < 1, 'the structured run occupies only its measured part of the requested window');
    assert.deepEqual(capacity.slotWait, { fastQuarterMs: 50, medianMs: 50, slowQuarterMs: 50, worstMs: 50, count: 1 });
    const text = await run(root, ['stats', '--window', '1h'], { now: () => new Date(now) });
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /runner slot waits: fast 0\.05s · median 0\.05s · slow 0\.05s · worst 0\.05s \(1 measured\)/u);
  } finally {
    if (priorMachineHome === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = priorMachineHome;
  }
});


test('[C7,O5] browser work waits when ordinary slots are free but browser slots are full', () => {
  const window = { from: '2026-10-24T11:00:00.000Z', to: '2026-10-24T12:00:00.000Z' };
  const stage = runnerApi.runnerStage([{
    id: 'local:test', kind: 'local', slots: { current: 2, limit: 2, elastic: false },
    capabilities: { os: 'darwin', browser: true }, active: 1, browserSlots: 1, browserActive: 1,
  }], [], window);
  assert.deepEqual(runnerApi.placeRunner(stage, { capabilities: { browser: true } }), { action: 'wait' });
  assert.deepEqual(runnerApi.placeRunner(stage, { capabilities: { browser: false } }), { action: 'run', runnerId: 'local:test' });

  const unknownBrowserUse = runnerApi.runnerStage([{
    id: 'local:unknown-browser-use', kind: 'local', slots: { current: 2, limit: 2, elastic: false },
    capabilities: { os: 'darwin', browser: true }, active: 1,
  }], [], window);
  assert.deepEqual(runnerApi.placeRunner(unknownBrowserUse, { capabilities: { browser: true } }), { action: 'wait' });
});


test('[C7,O5] legacy receipt timestamps leave runner shares and counts unknown', () => {
  const runners = ['local:a', 'ssh:b'].map((id, index) => ({
    id, kind: index ? 'ssh' : 'local', slots: { current: 2, limit: 2, elastic: false },
    capabilities: { os: null, browser: null }, active: 0,
  }));
  const stage = runnerApi.runnerStage(runners, [{
    at: '2026-10-24T11:30:00.000Z', waitMs: 10, runMs: 20,
  }], { from: '2026-10-24T11:00:00.000Z', to: '2026-10-24T12:00:00.000Z' });
  assert.deepEqual(stage.runners.map(row => [row.busyShare, row.runsServed]), [[null, null], [null, null]]);
  assert.deepEqual(stage.slotWait, { fastQuarterMs: 10, medianMs: 10, slowQuarterMs: 10, worstMs: 10, count: 1 });
});


/** Keep a real local admission open while observing a controlled physical interval. */
test('[C7,O5] an ongoing physical local holder contributes window occupancy without a completion', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-live-runner-stage-')));
  runFixtureGit(['init', '-q', '-b', 'main'], { cwd: root, stdio: 'pipe' });
  const board = openBoard(join(root, '.git', 'pullboard', 'board.sqlite'));
  const machineHome = join(root, 'machine');
  mkdirSync(machineHome, { recursive: true });
  writeFileSync(join(machineHome, 'settings.json'), JSON.stringify({ gateSlots: 2, browserSlots: 1 }));
  const prior = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = machineHome;
  const now = Date.now();
  t.mock.timers.enable({ apis: ['Date'], now });
  let lease;
  try {
    lease = await takeResource({ name: 'gate', capacity: 2, scope: 'machine', root,
      agent: 'private-ongoing-holder', item: 'ongoing', kind: 'check' });
    t.mock.timers.tick(10_000);
    const stage = readRunnerStage(root, { from: new Date(now).toISOString(), to: new Date(now + 10_000).toISOString() });
    const local = stage.runners.find(runner => runner.kind === 'local');
    assert.equal(local.active, 1);
    assert.equal(local.busyShare, 0.5, 'one physical admission occupied half of two slots through the observation');
    assert.equal(local.runsServed, 0, 'the still-held run is not a completion');
    assert.equal(stage.slotWait.count, 0, 'an open admission does not invent a completed receipt wait');
  } finally {
    lease?.release();
    if (prior === undefined) delete process.env.PULLBOARD_MACHINE_HOME;
    else process.env.PULLBOARD_MACHINE_HOME = prior;
    store.closeBoard(board);
    rmSync(root, { recursive: true, force: true });
  }
});


test('[C7,O5] open observations clip occupancy and leave remote admission or timing exclusivity unknown', () => {
  const window = { from: '2026-10-24T11:00:00.000Z', to: '2026-10-24T12:00:00.000Z' };
  const local = { id: 'local:open', kind: 'local', slots: { current: 2, limit: 2, elastic: false },
    capabilities: { os: 'darwin', browser: true }, active: 1 };
  const remote = { ...local, id: 'ssh:reserved', kind: 'ssh' };
  const stage = runnerApi.runnerStage([local, remote], [
    { ongoing: true, runner: local, admittedAt: '2026-10-24T10:30:00.000Z', observedUntil: '2026-10-24T11:30:00.000Z', waitMs: 999 },
    { ongoing: true, runner: remote, admittedAt: null, observedUntil: '2026-10-24T11:30:00.000Z' },
  ], window);
  assert.equal(stage.runners[0].busyShare, 0.25);
  assert.equal(stage.runners[0].runsServed, 0);
  assert.equal(stage.runners[1].busyShare, null, 'a controller reservation has no actual worker admitted boundary');
  assert.equal(stage.runners[1].runsServed, 0);
  assert.equal(stage.slotWait.count, 0);
  const timing = runnerApi.runnerStage([local], [{ ongoing: true, runner: local, timing: true,
    admittedAt: window.from, observedUntil: window.to }], window);
  assert.equal(timing.runners[0].busyShare, null, 'a timing flag alone cannot attest absence of legacy peers');
});


test('[C7,O5] measured browser saturation scales compatible elastic capacity without blocking ordinary work', () => {
  const window = { from: '2026-10-24T11:00:00.000Z', to: '2026-10-24T12:00:00.000Z' };
  const fixed = { id: 'fixed', kind: 'ssh', slots: { current: 2, limit: 2, elastic: false },
    capabilities: { os: 'darwin', browser: true }, active: 1, browserSlots: 1, browserActive: 1 };
  const elastic = { id: 'elastic', kind: 'elastic', slots: { current: 0, limit: 4, elastic: true },
    capabilities: { os: 'darwin', browser: true }, active: 0 };
  const stage = { ...runnerApi.runnerStage([fixed, elastic], [], window), slotWait: { medianMs: 50 } };
  const browser = { capabilities: { browser: true }, slotWaitTargetMs: 10 };
  assert.deepEqual(runnerApi.placeRunner(stage, browser), { action: 'scale', runnerId: 'elastic', slots: 1 });
  assert.deepEqual(runnerApi.placeRunner(stage, { ...browser, slotWaitTargetMs: 100 }), { action: 'wait' });
  assert.deepEqual(runnerApi.placeRunner(stage, { capabilities: { browser: false }, slotWaitTargetMs: 10 }), { action: 'run', runnerId: 'fixed' });
  const full = { ...stage, runners: stage.runners.map(runner => runner.id === 'elastic'
    ? { ...runner, slots: { ...runner.slots, current: 4 }, active: 4 } : runner) };
  assert.deepEqual(runnerApi.placeRunner(full, browser), { action: 'request' });
  const unknown = { ...stage, runners: stage.runners.map(runner => {
    if (runner.id !== 'fixed') return runner;
    const { browserSlots, browserActive, ...rest } = runner;
    return rest;
  }) };
  assert.deepEqual(runnerApi.placeRunner(unknown, browser), { action: 'wait' }, 'unknown browser occupancy is not measured saturation');
});
