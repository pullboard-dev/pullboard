/** @pullboard-test-input source-tree */
/** A trunk test-defect hold follows its repair item's live status, and the lander's refusal names the item and status [C7]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from './e2e-helpers.js';
import { onBoard } from './land-board-fixture.js';
import { makeLandProjectFixtures } from './land-project-fixture.js';
import { waitForCondition } from './runner-fixture-state.js';
import * as store from '../packages/store/index.js';
import { automaticLandingDirectory } from '../packages/landing/index.js';
import { heldTestDefects } from '../packages/landing/index.js';
import { landingPorts } from './landing-ports-fixture.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

/** The test file whose recorded defect holds the fixture trunk. */
const HELD = 'web/held.test.js';
const HELD_TEXT = "import test from 'node:test'; test('held case', () => {});\n";

/** Read one of the fixture's private wake files, or null. */
function wakeFile(box, name) {
  const file = join(automaticLandingDirectory(box.repo), name);
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/** The fixture's pending wake record, or null. */
function pending(box) {
  const text = wakeFile(box, 'pending.json');
  return text ? JSON.parse(text) : null;
}

/** Stop the fixture's detached landers and timers. */
function stopLanders(box) {
  for (const name of ['pending.json', 'timer.json']) {
    const text = wakeFile(box, name);
    const saved = text ? JSON.parse(text) : null;
    for (const pid of [saved?.pid, saved?.running?.pid]) {
      if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
}

/** Run a real command on the trunk checkout; its post-command step is what wakes the lander. */
function command(box, ...args) {
  const result = box.run(box.repo, ...args);
  assert.equal(result.code, 0, result.out + result.err);
  return result;
}

/** Whether the board recorded the item merged. */
function merged(box, id) {
  return onBoard(box, board => store.getItem(board, id).item_merged_commit ?? null);
}

/**
 * A real project with automatic landing on, one accepted unlanded item waiting, and a trunk held by a recorded landing
 * test defect on web/held.test.js whose repair item is open.
 */
function heldTrunk(t) {
  const box = landProject();
  t.after(() => stopLanders(box));
  const entry = itemWorktree(box, 1);
  submitItem(box, entry);
  acceptItem(box, entry);
  mkdirSync(dirname(join(box.repo, HELD)), { recursive: true });
  writeFileSync(join(box.repo, HELD), HELD_TEXT);
  box.git(box.repo, 'add', HELD);
  box.git(box.repo, 'commit', '-q', '-m', 'test: add the fixture test the defect holds');
  const blob = box.git(box.repo, 'rev-parse', `HEAD:${HELD}`);
  const branch = box.git(box.repo, 'symbolic-ref', 'HEAD');
  const defect = onBoard(box, board => store.recordLandingTestDefect(board, { agentId: 'coordinator', test: HELD,
    hash: createHash('sha256').update(HELD_TEXT).digest('hex'), blob, trunkBlob: blob, names: ['held case'], lane: 'web',
    batchId: randomUUID(), branch }));
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify({ ...config, landing: { ...config.landing, manualOverride: false } }, null, 2));
  box.git(box.repo, 'add', 'pullboard.json');
  box.git(box.repo, 'commit', '-q', '-m', 'chore: the board lands accepted items');
  return { box, entry, defect, branch };
}

/** Let a real command wake the real lander on the held trunk, and wait until it refuses LAND_TEST_DEFECT and backs off. */
async function backingOff(box) {
  command(box, 'list');
  let record = null;
  await waitForCondition(() => (record = pending(box))?.backoff?.outcome === 'LAND_TEST_DEFECT',
    'the woken lander refuses on the held trunk and backs off', { signal: AbortSignal.timeout(90_000), state: () => pending(box) });
  return record;
}

/** The defects the real landing step holds the current trunk with. */
function held(box, branch) {
  return onBoard(box, board => heldTestDefects(box.repo, board, { branch, commit: box.git(box.repo, 'rev-parse', 'HEAD') }, landingPorts));
}

test('clause 1: a trunk held by a test-defect item that is then withdrawn: the lander\'s next pass drops the hold and lands the waiting accepted item, with no coordinator landing [C7]', { timeout: 300_000 }, async t => { // budget: real held and real landed lander passes in a private repo; hang ceiling, not speed.
  const { box, entry, defect, branch } = heldTrunk(t);
  const first = await backingOff(box);
  assert.deepEqual(Object.keys(first.backoff.marks.held), [HELD], 'the backed-off lander watches the held test file');
  assert.equal(merged(box, entry.item), null, 'the open defect holds the accepted item');
  assert.deepEqual(held(box, branch).map(row => [row.item, row.status]), [[defect.item, 'open']], 'the open repair item holds the trunk');

  command(box, 'withdraw', String(defect.item), 'the held test needs no repair');
  assert.equal(onBoard(box, board => store.getItem(board, defect.item).item_status), 'withdrawn');
  assert.deepEqual(held(box, branch), [], 'a withdrawn repair item holds nothing');
  assert.deepEqual(onBoard(box, board => store.landingTestDefects(board)).map(row => row.item), [defect.item],
    'the defect record itself is unchanged: the hold follows the item\'s live status, not a cleared record');

  // No pullboard land: the automatic lander's own next pass lands the waiting item.
  await waitForCondition(() => merged(box, entry.item) !== null, 'the lander\'s next pass lands the waiting accepted item',
    { signal: AbortSignal.timeout(180_000), state: () => pending(box) });
  const closings = onBoard(box, board => store.events(board).filter(event => event.event_kind === 'landing-test-defect-closed'));
  assert.deepEqual(closings, [], 'nothing closed the defect: the withdrawal alone released the trunk');
});

test('clause 2: the lander\'s LAND_TEST_DEFECT refusal names the defect item and its live status in worker.log [C7]', { timeout: 300_000 }, async t => { // budget: one real held lander pass in a private repo; hang ceiling, not speed.
  const { box, defect } = heldTrunk(t);
  await backingOff(box);
  const expected = `landing held: [LAND_TEST_DEFECT] this trunk is held by #${defect.item} (open; ${HELD})`;
  await waitForCondition(() => (wakeFile(box, 'worker.log') ?? '').includes(expected), 'worker.log names the holding item and its status',
    { signal: AbortSignal.timeout(30_000), state: () => wakeFile(box, 'worker.log') });
});
