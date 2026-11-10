/** Windowed runner capacity and placement API fixture [C7,O5]. */
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import * as runnerApi from '../../../../../packages/runners/index.js';

/** Seed the native private Git/SQLite context before exercising the namespace API. */
export async function runnerStageFixture(t, e2e) {
  const box = e2e.project('true');
  const boardFile = join(box.repo, '.git', 'pullboard', 'board.sqlite');
  const board = new DatabaseSync(boardFile, { readOnly: true });
  try {
    assert.ok(board.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'event'").get()?.present,
      'the fixture has its own initialized native board database');
  } finally { board.close(); }

  // A missing export fails after the private native setup instead of as an import/setup error.
  assert.equal(typeof runnerApi.runnerStage, 'function', 'runnerStage is available from the runner namespace');
  assert.equal(typeof runnerApi.placeRunner, 'function', 'placeRunner is available from the runner namespace');

  const from = Date.parse('2026-10-24T00:00:00.000Z');
  const to = from + 1_000;
  const runners = [
    { id: 'runner-a', kind: 'ssh', slots: { current: 2, limit: 2, elastic: false }, capabilities: { os: 'linux', browser: true }, active: 2 },
    { id: 'runner-b', kind: 'ci', slots: { current: 2, limit: 2, elastic: false }, capabilities: { os: 'darwin', browser: false }, active: 0 },
    { id: 'runner-c', kind: 'elastic', slots: { current: 0, limit: 4, elastic: true }, capabilities: { os: 'linux', browser: true }, active: 0 },
    { id: 'runner-d', kind: 'local', slots: { current: 1, limit: 1, elastic: false }, capabilities: { os: 'linux', browser: true }, active: 1 },
    { id: 'runner-e', kind: 'ssh', slots: { current: 2, limit: 2, elastic: false }, capabilities: { os: 'windows', browser: true }, active: 1 },
  ];
  const at = milliseconds => new Date(milliseconds).toISOString();
  const receiptRunner = (runner, slots = runner.slots) => ({ id: runner.id, kind: runner.kind,
    slots: structuredClone(slots), capabilities: { ...runner.capabilities } });
  const receipts = [
    { runner: receiptRunner(runners[0]), timing: true, admittedAt: at(from - 500), finishedAt: at(from + 500), waitMs: 10 },
    { runner: receiptRunner(runners[0]), occupiedSlots: 2, admittedAt: at(from + 500), finishedAt: at(to + 500), waitMs: 50 },
    { runner: receiptRunner(runners[1], { ...runners[1].slots, current: 1 }), admittedAt: at(from - 5_000), finishedAt: at(from - 4_000), waitMs: 5 },
    { runner: receiptRunner(runners[3]), admittedAt: at(from - 100), finishedAt: at(from + 300), waitMs: 30 },
    { runner: receiptRunner(runners[4], { ...runners[4].slots, current: 1 }), admittedAt: at(from + 100), finishedAt: at(to + 100), waitMs: 99 },
  ];
  const stage = runnerApi.runnerStage(runners, receipts, { from: at(from), to: at(to) });
  const byId = id => stage.runners.find(runner => runner.id === id);

  assert.deepEqual(byId('runner-a'), { ...runners[0], busyShare: 1, runsServed: 1 },
    'the descriptor is preserved with its clipped capacity share and in-window completions');
  assert.equal(byId('runner-a').busyShare, 1,
    'exclusive timing and an explicitly full-capacity receipt saturate the two-slot runner');
  assert.equal(byId('runner-a').runsServed, 1, 'only completions inside the half-open window count');
  assert.equal(byId('runner-b').busyShare, 0, 'idle runner with only out-of-window history has measured zero share');
  assert.equal(byId('runner-b').runsServed, 0, 'out-of-window completion is excluded');
  assert.equal(byId('runner-c').busyShare, null, 'zero current capacity has unknown share, not a fabricated zero');
  assert.equal(byId('runner-c').runsServed, 0);
  assert.equal(byId('runner-d').busyShare, 0.3, 'a run crossing the left boundary is clipped to the window');
  assert.equal(byId('runner-d').runsServed, 1);
  assert.equal(byId('runner-e').busyShare, null, 'a receipt with stale capacity leaves the share unknown');
  assert.deepEqual(stage.slotWait, { fastQuarterMs: 10, medianMs: 20, slowQuarterMs: 30, worstMs: 30, count: 2 },
    'only finite waits for runs completed in the half-open window form the quartiles');

  const linuxBrowser = { capabilities: { os: 'linux', browser: true }, slotWaitTargetMs: 15 };
  assert.deepEqual(runnerApi.placeRunner(stage, { slotWaitTargetMs: 15 }),
    { action: 'run', runnerId: 'runner-b' }, 'an unconstrained request picks the least-busy compatible runner');
  assert.deepEqual(runnerApi.placeRunner(stage, { capabilities: { os: 'darwin', browser: false }, slotWaitTargetMs: 15 }),
    { action: 'run', runnerId: 'runner-b' }, 'an idle compatible fixed runner runs; an incompatible one is not selected');
  assert.deepEqual(runnerApi.placeRunner(stage, linuxBrowser),
    { action: 'scale', runnerId: 'runner-c', slots: 1 }, 'scale the elastic runner only after compatible fixed slots are busy past target');

  const waiting = runnerApi.placeRunner(stage, { ...linuxBrowser, slotWaitTargetMs: 25 });
  assert.equal(waiting.action, 'wait', 'below the measured wait threshold, keep waiting');
  const full = structuredClone(stage);
  const elastic = full.runners.find(runner => runner.id === 'runner-c');
  elastic.slots.current = elastic.slots.limit;
  elastic.active = elastic.slots.current;
  assert.deepEqual(runnerApi.placeRunner(full, linuxBrowser), { action: 'request' },
    'request elastic capacity only after all matching fixed and elastic capacity is saturated');
  assert.deepEqual(runnerApi.placeRunner(stage, { capabilities: { os: 'freebsd', browser: true }, slotWaitTargetMs: 15 }),
    { action: 'incompatible' }, 'do not scale a pool that cannot satisfy the requested capabilities');
}
