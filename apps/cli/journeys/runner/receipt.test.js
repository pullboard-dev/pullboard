/** A posted gate-job receipt becomes the item's gate result: green goes to review, red back to its builder, a stale one changes nothing [P7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../packages/api/index.js';
import { jobsOf } from '../../../../packages/jobs/index.js';
import { getItem } from '../../../../packages/store/index.js';
import { itemThread } from '../../../../packages/store/index.js';
import { pullProject } from '../../tests/fixtures/pull.js';
import { pullQueue } from '../../tests/fixtures/pull.js';
import { serveOnce } from '../../tests/fixtures/pull.js';
import { submitOne } from '../../tests/fixtures/pull.js';

/** The loopback board queue that applies each recorded receipt, as the board API's jobs route does. */
function applyingQueue(t, box) {
  return pullQueue(t, box, { queue: (current, body) => boardJobQueueCall(current, body, { mode: 'pull', trunk: () => box.repo }) });
}

/** The text of every fact on an item's thread. */
function facts(board, id) {
  return itemThread(board, id).filter(entry => entry.type === 'fact').map(entry => entry.text ?? entry.fact?.text ?? '').join('\n');
}

test('clause 1: a green receipt sends the item to review at its candidate, and a red one returns it to its builder with the failing parts [P7]', { timeout: 240_000 }, // budget: hang ceiling for a project, two submits and two whole gates in runner processes.
async t => {
  // The second item's frozen check fails, so its gate is red in the check phase.
  const box = await pullProject(t, 2, { check: n => n === 2 ? 'node -e "process.exit(3)"' : 'true' });
  const [green, red] = box.ids;
  const greenSubmit = submitOne(box, green);
  const redSubmit = submitOne(box, red);
  const { board, url } = await applyingQueue(t, box);
  const builder = getItem(board, green).item_owner;
  for (const runner of ['r-one', 'r-two']) assert.equal((await serveOnce(box, url, runner)).code, 0);

  const passed = getItem(board, green);
  const receiptOf = id => JSON.stringify(jobsOf(board.db, { kind: 'gate', item: id }).map(job => job.steps.find(step => step.name === 'receipt')?.payload.receipt)).slice(0, 6000);
  assert.equal(passed.item_status, 'submitted', `green: the item is in review; ${facts(board, green)}; ${receiptOf(green)}`);
  assert.equal(passed.item_commit, greenSubmit.commit, 'at the candidate the gate judged');
  assert.match(facts(board, green), /green at [0-9a-f]{12}.*submitted for review/u);

  const failed = getItem(board, red);
  assert.equal(failed.item_status, 'claimed', 'red: the item stays with its builder');
  assert.equal(failed.item_owner, builder);
  assert.match(facts(board, red), new RegExp(`red at ${redSubmit.commit.slice(0, 12)}; failing parts:\\ncheck exited 3`, 'u'), 'the failing part is named');
  const [row] = jobsOf(board.db, { kind: 'gate', item: red });
  assert.equal(row.steps.find(step => step.name === 'receipt').payload.receipt.gate.green, false);
});

test('clause 2: a receipt for a candidate that is no longer the item\'s head is recorded but changes nothing [P7]', { timeout: 240_000 }, // budget: as clause 1.
async t => {
  const box = await pullProject(t, 1);
  const [id] = box.ids;
  const first = submitOne(box, id);
  // The builder commits again and resubmits: a newer gate job now holds the item's head.
  assert.equal(box.helpers.commitFile(box, first.folder, `web/${id}-again.txt`, 'again\n', `feat(web): pulled gate ${id} again [G1]`).status, 0);
  const again = box.run(first.folder, 'submit', String(id), '--json');
  assert.equal(again.code, 0, `${again.err}\n${again.out}`);
  const second = box.git(first.folder, 'rev-parse', 'HEAD');
  const { board, url } = await applyingQueue(t, box);
  const jobs = jobsOf(board.db, { kind: 'gate', item: id });
  assert.deepEqual(jobs.map(job => job.candidate), [first.commit, second]);
  const before = facts(board, id);

  // The oldest open job runs first: the first candidate's.
  assert.equal((await serveOnce(box, url, 'r-old')).code, 0);
  const old = jobsOf(board.db, { kind: 'gate', item: id })[0];
  assert.equal(old.step, 'done');
  assert.equal(old.steps.find(step => step.name === 'receipt').payload.receipt.gate.green, true, `the stale receipt is recorded on its job: ${JSON.stringify(old.steps.find(step => step.name === 'receipt').payload.receipt).slice(0, 6000)}`);
  assert.equal(getItem(board, id).item_status, 'claimed', 'and the item is unchanged');
  assert.equal(facts(board, id), before, 'no fact was written for it');

  assert.equal((await serveOnce(box, url, 'r-new')).code, 0);
  const current = getItem(board, id);
  assert.deepEqual([current.item_status, current.item_commit], ['submitted', second], 'the current candidate\'s receipt is the item\'s result');
});
