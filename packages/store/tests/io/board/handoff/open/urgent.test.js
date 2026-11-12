/** Queued gates of urgent or pinned items start before routine ones; routine ones keep submit order [C7]. */
import assert from 'node:assert/strict';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import * as store from '../../../../../index.js';
import { itemUrgent } from '../../../../../index.js';
import {
  drainHandoffQueue,
  handoffQueueDirectory,
  queueHandoffLaunch,
  reserveHandoffTicket,
} from '../../../../../../resources/index.js';
import { fixtureBoard } from '../../../../../../../apps/cli/tests/fixtures/board.js';
import { waitForCondition } from '../../../../../../../apps/cli/tests/fixtures/runner/holders.js';

/** A real worker process that exits at once; the dispatcher's start order is the proof. */
const WORKER = 'process.exit(0);\n';

/** A private machine home and captured tools tree; the environment is restored after the test. */
function machine(t) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'pullboard-handoff-urgent-')));
  const tools = join(dir, 'tools');
  mkdirSync(join(tools, 'apps/cli/src/io/gate'), { recursive: true });
  writeFileSync(join(tools, 'apps/cli/src/io/gate/drive.js'), WORKER);
  const saved = process.env.PULLBOARD_MACHINE_HOME;
  process.env.PULLBOARD_MACHINE_HOME = join(dir, 'home');
  t.after(() => {
    if (saved === undefined) delete process.env.PULLBOARD_MACHINE_HOME; else process.env.PULLBOARD_MACHINE_HOME = saved;
    rmSync(dir, { recursive: true, force: true });
  });
  return { dir, tools };
}

test('an urgent or pinned item\'s queued gate starts before every routine queued gate, and routine gates keep submit order [C7,#3062]', async t => {
  const box = machine(t);
  const board = fixtureBoard(t);
  store.register(board, { lane: 'coordinator', path: '/private/urgent-main' });
  const add = title => store.addItem(board, { by: 'coordinator', lane: 'core', title });
  const ids = ['routine one', 'routine two', 'urgent fix', 'routine three', 'pinned fix', 'unmarked again'].map(add);
  const [one, two, urgent, three, pinned, unmarked] = ids;
  store.appendFact(board, urgent, { agentId: 'coordinator', kind: 'urgent', text: 'on', asPerson: true, channel: 'terminal' });
  store.appendFact(board, unmarked, { agentId: 'coordinator', kind: 'urgent', text: 'on', asPerson: true, channel: 'terminal' });
  store.appendFact(board, unmarked, { agentId: 'coordinator', kind: 'urgent', text: 'off', asPerson: true, channel: 'terminal' });
  store.addMilestone(board, { agentId: 'coordinator', reason: 'Fixture milestone for pins.', name: 'speed', items: ids });
  store.orderMilestoneItems(board, 'speed', { agentId: 'coordinator', items: [pinned], place: 'pin', reason: 'Unblocks every seat.' });
  assert.deepEqual(ids.map(id => itemUrgent(board, id)), [false, false, true, false, true, false], 'urgency is the person mark or a milestone pin');

  // Submit order: each submit reserves its place with the urgency read from the board, as enqueueSubmitHandoff does.
  for (const id of ids) {
    const job = `job-${id}`;
    const directory = join(box.dir, 'jobs', job);
    mkdirSync(directory, { recursive: true });
    queueHandoffLaunch({ directory, tools: box.tools, commonDir: box.dir, job }, await reserveHandoffTicket(job, { urgent: itemUrgent(board, id) }));
  }
  const { started } = await drainHandoffQueue({ capacity: 1, pollMs: 20 });
  assert.deepEqual(started, [urgent, pinned, one, two, three, unmarked].map(id => `job-${id}`),
    'urgent gates start first in their own submit order, then routine gates in submit order');
  assert.deepEqual(readdirSync(handoffQueueDirectory()).filter(name => /\.(json|reserved)$/u.test(name) && /^\d/u.test(name)), [], 'the queue drained');
});

test('a live routine reservation never holds back a later gate, urgent or routine [C7,#3062,#5727]', async t => {
  const box = machine(t);
  const held = await reserveHandoffTicket('job-slow-routine', { startOf: () => 'same' });
  const queue = (job, urgent) => reserveHandoffTicket(job, { urgent }).then(place => {
    const directory = join(box.dir, 'jobs', job);
    mkdirSync(directory, { recursive: true });
    return queueHandoffLaunch({ directory, tools: box.tools, commonDir: box.dir, job }, place);
  });
  await queue('job-later-routine', false);
  await queue('job-later-urgent', true);
  const draining = drainHandoffQueue({ capacity: 2, pollMs: 20 });
  // The slow submit's process dies once the urgent gate has started, giving up its held place to the routine one behind it.
  let urgentFirst;
  try {
    urgentFirst = await waitForCondition(() => !readdirSync(handoffQueueDirectory()).some(name => name.includes('job-later-urgent')), 'the urgent gate starts',
      { signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]) }).then(() => true, () => false);
    assert.ok(readdirSync(handoffQueueDirectory()).includes(held), 'the live routine reservation still holds its place');
    // Since #5727 a live reservation keeps its place number but never holds back a later ticket while workers run below the cap.
    const routineStarted = await waitForCondition(() => !readdirSync(handoffQueueDirectory()).some(name => name.includes('job-later-routine')), 'the routine gate starts',
      { signal: AbortSignal.any([t.signal, AbortSignal.timeout(5_000)]) }).then(() => true, () => false);
    assert.ok(routineStarted, 'the routine gate starts below the cap without waiting for the live reservation');
    assert.ok(readdirSync(handoffQueueDirectory()).includes(held), 'the live routine reservation still holds its place after the later gates started');
  } finally { writeFileSync(join(handoffQueueDirectory(), held), JSON.stringify({ pid: 2 ** 22 + 12345, started: 'gone' }) + '\n'); }
  const { started } = await draining;
  assert.ok(urgentFirst, 'the urgent gate started while the routine reservation was live');
  assert.deepEqual(started, ['job-later-urgent', 'job-later-routine'], 'both later gates pass the live reservation, the urgent one first');
});
