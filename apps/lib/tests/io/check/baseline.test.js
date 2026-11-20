/** An item's check baseline runs on the runners, never as a pile of local runners on the board machine [C7,#10787]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureBoard } from '../../fixtures/board.js';
import { addItem } from '../../../../../packages/store/index.js';
import { getItem } from '../../../../../packages/store/index.js';
import { offerCheckBaseline } from '../../../../../packages/api/index.js';
import { applyJobReceipt } from '../../../../../packages/api/index.js';
import { provideBaselineRecorder } from '../../../../../packages/api/index.js';
import { recordPulledBaseline } from '../../../../../packages/gate/index.js';
import { jobView } from '../../../../../packages/jobs/index.js';
import { launchCheckBaseline } from '../../../src/io/check/baseline.js';

const MAIN = 'a'.repeat(40);
const LINE = 'PULLBOARD_CHECK_BASELINE ';

/** An item on a real board with a pending baseline, as add records it before launching. */
function pendingItem(board, n) {
  const request = `${String(n).padStart(8, '0')}-1111-4111-8111-111111111111`;
  const command = `node -e "process.exit(${n % 2})"`;
  const baseline = { command, main: MAIN, result: 'pending', request };
  const id = addItem(board, { by: 'coordinator', lane: 'web', title: `Baseline ${n}`, check: command, checkBaseline: baseline });
  return { id, baseline };
}

/**
 * Ports as add wires them, over a real board: offer queues the real check-baseline job; local queues it the same way for
 * the machine's local runner and starts that runner only when none is live, as ensureLocalRunner does; spawn is the
 * detached worker. `machine` counts the processes this machine would start.
 */
function wiring(board, settings, machine = { runner: 0, workers: 0, jobs: [] }) {
  const queue = item => machine.jobs.push(offerCheckBaseline(board.db, { item: item.id, expected: item.baseline, command: item.baseline.command }).id);
  return { machine, ports: item => ({ settings,
    offer: () => { queue(item); return true; },
    local: async () => { queue(item); if (machine.runner === 0) machine.runner = 1; return true; },
    spawn: async () => { machine.workers += 1; } }) };
}

test('lib.io-check-baseline.runners-only-queues-a-runner-job: clause 1: with gate.runnersOnly on, the baseline after add or edit is queued as a runner job and starts no local runner or worker on the board machine [C7,#10787]', async t => {
  const board = fixtureBoard(t);
  const { machine, ports } = wiring(board, { gate: { runnersOnly: true }, runners: [] });
  const items = Array.from({ length: 20 }, (_, n) => pendingItem(board, n + 1));
  for (const item of items) assert.deepEqual(await launchCheckBaseline(item, ports(item)), { route: 'runner-job' });
  assert.equal(machine.runner, 0, 'no local runner is started or offered to');
  assert.equal(machine.workers, 0, 'no detached worker, and so no committed-runner controller, starts on the board machine');
  assert.deepEqual(machine.jobs, items.map(item => `baseline:${item.id}:${item.baseline.request}`));
  assert.deepEqual(machine.jobs.map(job => jobView(board.db, job).item), items.map(item => item.id), 'each job waits on the board queue for a runner');
  // Registered runners route the same way with the setting off.
  const registered = wiring(board, { gate: { runnersOnly: false }, runners: [{ host: 'mini.local' }] });
  const item = pendingItem(board, 21);
  assert.deepEqual(await launchCheckBaseline(item, registered.ports(item)), { route: 'runner-job' });
  assert.deepEqual([registered.machine.runner, registered.machine.workers], [0, 0]);
});

test('lib.io-check-baseline.one-local-baseline-at-a-time: clause 2: with runners off at most one local baseline runs at a time, and a later add queues behind it instead of starting another [C7,#10787]', async t => {
  const board = fixtureBoard(t);
  const { machine, ports } = wiring(board, { gate: { runnersOnly: false }, runners: [] });
  const items = Array.from({ length: 20 }, (_, n) => pendingItem(board, n + 1));
  for (const item of items) assert.deepEqual(await launchCheckBaseline(item, ports(item)), { route: 'local-runner' });
  assert.equal(machine.runner, 1, 'one local runner serves every baseline');
  assert.equal(machine.workers, 0, 'no add starts a detached worker beside it');
  assert.deepEqual(machine.jobs.map(job => jobView(board.db, job).item), items.map(item => item.id), 'later adds wait on the board queue in order');
  // With no local runner either, nothing starts here and the baseline stays pending.
  const none = { ...ports(items[0]), local: async () => false };
  const item = pendingItem(board, 21);
  assert.deepEqual(await launchCheckBaseline(item, none), { route: 'pending' });
  assert.equal(machine.workers, 0);
  assert.equal(getItem(board, item.id).item_check_baseline.result, 'pending');
});

test('lib.io-check-baseline.runner-job-records-pass-or-fail: clause 3: a baseline launched through apps/lib/src/io/check/baseline.js still records its pass or fail on the item exactly as today [C7,#10787]', async t => {
  const board = fixtureBoard(t);
  provideBaselineRecorder(recordPulledBaseline);
  t.after(() => provideBaselineRecorder(null));
  const { machine, ports } = wiring(board, { gate: { runnersOnly: true }, runners: [] });
  for (const [n, status, result] of [[2, 0, 'green'], [3, 1, 'red']]) {
    const item = pendingItem(board, n);
    assert.equal((await launchCheckBaseline(item, ports(item))).route, 'runner-job');
    const tail = `ran the check\n${LINE}${JSON.stringify({ status, seconds: 4 })}\n`;
    assert.deepEqual(applyJobReceipt(board, { job: machine.jobs.at(-1), receipt: { tail } }), { applied: true, outcome: 'recorded' },
      'the board applies the runner receipt as for any pulled baseline');
    const recorded = getItem(board, item.id).item_check_baseline;
    assert.equal(recorded.result, result);
    assert.equal(recorded.command, item.baseline.command);
    assert.equal(recorded.main, MAIN);
    assert.equal(recorded.request, item.baseline.request);
    assert.equal(recorded.seconds, 4);
  }
  // A baseline that is no longer pending launches nothing.
  const done = { id: 99, baseline: { result: 'green', request: '99999999-1111-4111-8111-111111111111' } };
  assert.deepEqual(await launchCheckBaseline(done, ports(done)), { route: 'none' });
  assert.equal(machine.workers, 0);
});
