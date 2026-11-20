import { addItem } from '../../../../store/index.js';
import { addMilestone } from '../../../../store/index.js';
import { closeBoard } from '../../../../store/index.js';
import { moveMilestone } from '../../../../store/index.js';
/** Real board, roadmap and queue scenarios for release admission [C7,V4]. */
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const GATE_MODULE = pathToFileURL(resolve(import.meta.dirname, '../../../index.js')).href;
/** The child process source for one queued gate action; the caller supplies the execution-services source. */
const releaseWorker = executionServicesSource => `
import { withGateSlot } from ${JSON.stringify(GATE_MODULE)};
${executionServicesSource(GATE_MODULE)}
const [root, agent, item, kind, landing] = process.argv.slice(1);
let said = false;
await withGateSlot(root, async () => {
  console.log(JSON.stringify({ acquired: agent }));
  for await (const line of process.stdin) if (String(line).trim() === 'release') break;
}, { executionServices, agent, item, kind, landing: landing === 'true', remote: false, onWait: state => {
  if (!said || state.rejoined) { said = true; console.log(JSON.stringify({ queued: state })); }
} });
`;

/** Open the fixture repository's board file in process with the opener the calling test passes in; the first open creates the production schema. */
function openFixtureBoard(root, openKitBoard) {
  mkdirSync(join(root, '.git', 'pullboard'), { recursive: true });
  return openKitBoard(join(root, '.git', 'pullboard', 'board.sqlite'), undefined, { gitRoot: root });
}

/** Seed the queue's real SQLite roadmap through canonical public writes on a board the fixture opens itself. */
function board(box, root, openKitBoard) {
  const state = openFixtureBoard(root, openKitBoard);
  try {
    for (const title of ['Current work', 'Later work', 'Unplanned work']) addItem(state, { by: 'coordinator', lane: 'coordinator', title });
    addMilestone(state, { agentId: 'coordinator', name: 'current', items: [1], reason: 'Arrange current release for queue fixture' });
    addMilestone(state, { agentId: 'coordinator', name: 'later', items: [2], reason: 'Arrange later release for queue fixture' });
  } finally { closeBoard(state); }
}

/** Move a milestone ahead of another, as `pullboard milestone move` does, through the store move. */
function moveBefore(root, name, before, openKitBoard) {
  const state = openFixtureBoard(root, openKitBoard);
  try { moveMilestone(state, name, { agentId: 'coordinator', before }); } finally { closeBoard(state); }
}

/** Change only this test's private machine settings, preserving both gate slots. */
function settings(box, queue) {
  mkdirSync(box.home, { recursive: true });
  writeFileSync(join(box.home, 'settings.json'), JSON.stringify({ gateSlots: 2, gate: { queue } }) + '\n');
}

/** Move one private waiter's clock back; no live board or shared machine database is changed. */
function age(box, agent) {
  const db = new DatabaseSync(join(box.home, 'resources.sqlite'));
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    assert.equal(db.prepare('UPDATE waiter SET since = ? WHERE agent = ?').run(new Date(Date.now() - 61_000).toISOString(), agent).changes, 1); // budget: derived from the declared one-minute queue age, injecting a private clock without elapsed waiting.
  } finally { db.close(); }
}

/**
 * Exercise release ordering through withGateSlot, real private boards and child processes.
 * The named test stays in resources.test.js; its scenarios live here so the already large queue
 * test file does not grow another block of fixture code. The outer native runner owns the real
 * machine lease; these child queues use only the fixture's separate machine home.
 *
 * @param {{ openKitBoard: Function, fixture: Function, poolWorker: Function, privateList: Function, event: Function, acquired: Function, release: Function, legacyModule: string, machineSettings: Function, executionServicesSource: Function }} helpers
 * @returns {Promise<void>}
 */
export async function releaseQueueProof(helpers) {
  const { openKitBoard, fixture, poolWorker, privateList, event, acquired, release, legacyModule, executionServicesSource } = helpers;
  const line = box => privateList(box).find(row => row.name === 'gate').line.map(row => row.agent);
  /** Launch a real gate action that captures its board and item when joining the pool. */
  const run = (box, root, agent, item, kind = 'submit', landing = false) => {
    const child = poolWorker(box, { agent, script: releaseWorker(executionServicesSource), args: [root, agent, String(item), kind, String(landing)] });
    child.releaseAgent = agent;
    return child;
  };
  /** Fill both slots, so all later runs demonstrably join the waiting line. */
  const hold = async box => {
    const holders = [poolWorker(box, { agent: 'holder-one' }), poolWorker(box, { agent: 'holder-two' })];
    for (const holder of holders) await acquired(holder);
    return holders;
  };
  /** Queue one run and wait until its admission metadata has been stored. */
  const queue = async (...args) => {
    const child = run(...args);
    assert.ok((await event(child)).queued, 'a full pool keeps this run queued');
    return child;
  };
  /** Release exactly one holder and prove the remaining runs execute in the reported order. */
  const drain = async (box, holders, children) => {
    await release(holders[0]);
    for (const [index, child] of children.entries()) {
      assert.equal((await acquired(child)).acquired, child.releaseAgent);
      assert.deepEqual(line(box), children.slice(index + 1).map(entry => entry.releaseAgent),
        'consuming one opportunity leaves every other board in its remaining positions');
      await release(child);
    }
    await release(holders[1]);
  };

  const off = fixture();
  board(off, off.first, openKitBoard);
  const offHolders = await hold(off);
  const offLater = await queue(off, off.first, 'off-later', 2);
  const offCurrent = await queue(off, off.first, 'off-current', 1);
  assert.deepEqual(line(off), ['off-later', 'off-current'], 'absent release setting preserves arrival');
  await drain(off, offHolders, [offLater, offCurrent]);

  const on = fixture();
  board(on, on.first, openKitBoard);
  board(on, on.second, openKitBoard);
  settings(on, { currentReleaseFirst: true });
  const onHolders = await hold(on);
  const unplanned = await queue(on, on.first, 'A-unplanned', 3, 'focused');
  const foreign = await queue(on, on.second, 'B-current', 1);
  const later = await queue(on, on.first, 'A-later', 2);
  const current = await queue(on, on.first, 'A-current', 1);
  const landing = await queue(on, on.first, 'A-landing', 3, 'landing', true);
  assert.deepEqual(line(on), ['A-landing', 'A-current', 'B-current', 'A-later', 'A-unplanned'],
    'landing stays first and each board retains its opportunity positions');
  assert.equal(helpers.machineSettings(off, 'gateQueueSettings').value.currentReleaseFirst, false);
  moveBefore(on.first, 'later', 'current', openKitBoard);
  assert.deepEqual(line(on), ['A-landing', 'A-current', 'B-current', 'A-later', 'A-unplanned'],
    'queued ranks remain captured despite a roadmap reorder');
  await drain(on, onHolders, [landing, current, foreign, later, unplanned]);
  assert.equal(helpers.machineSettings(on, 'gateQueueSettings').value.currentReleaseFirst, true);

  const aging = fixture();
  board(aging, aging.first, openKitBoard);
  settings(aging, { reviewsFirst: true, currentReleaseFirst: true, agingMinutes: 1 });
  const agingHolders = await hold(aging);
  const aged = await queue(aging, aging.first, 'aged-unplanned', 3, 'focused');
  age(aging, 'aged-unplanned');
  const young = await queue(aging, aging.first, 'young-current', 1);
  const review = await queue(aging, aging.first, 'review-later', 2, 'review');
  assert.deepEqual(line(aging), ['review-later', 'aged-unplanned', 'young-current'],
    'release priority cannot displace global review class or an aged waiter');
  await drain(aging, agingHolders, [review, aged, young]);

  const mixed = fixture();
  board(mixed, mixed.first, openKitBoard);
  settings(mixed, { reviewsFirst: true, currentReleaseFirst: true });
  const mixedHolders = await hold(mixed);
  const old = poolWorker(mixed, { agent: 'legacy-focused', kind: 'focused', module: legacyModule });
  old.releaseAgent = 'legacy-focused';
  assert.ok((await event(old)).queued);
  const newReview = await queue(mixed, mixed.first, 'new-current-review', 1, 'review');
  assert.deepEqual(line(mixed), ['legacy-focused', 'new-current-review'], 'all clients agree on arrival while a legacy client waits');
  assert.equal(privateList(mixed).find(row => row.name === 'gate').order, 'arrival');
  await drain(mixed, mixedHolders, [old, newReview]);

  settings(aging, { currentReleaseFirst: 'yes' });
  const bad = helpers.machineSettings(aging, 'loadMachineSettings');
  assert.ok(bad.error, 'a non-boolean release setting is refused');
  assert.match(bad.error.message, /gate\.queue\.currentReleaseFirst/u);
}
