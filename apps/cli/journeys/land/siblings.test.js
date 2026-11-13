/** Sibling items that collide on one file: their runner land job names the conflict, split from land/main for its file budget [B3,R3,E8]. */
import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { landJobs } from '../../tests/fixtures/land/board.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('land names sibling conflicts whose reviews share the unchanged main [B3,R3,E8]', async () => {
  const box = landProject();
  const file = FILES[0];
  const entries = [1, 2].map(number => itemWorktree(box, number, file));
  submitItem(box, entries[0], 'PASS\n// first sibling\n');
  submitItem(box, entries[1], 'PASS\n// second sibling\n');
  for (const entry of entries) acceptItem(box, entry);
  const base = box.git(box.repo, 'rev-parse', 'main');
  // Both reviews share the unchanged main; the hand landing offers them as one runner land job, which lands the first
  // sibling and returns the second with its collision named, as the host batch did (lands the first, conflicts the second) [P7].
  const landed = await box.runLocal(box.repo, 'land');
  assert.equal(landed.code, 0, landed.out + landed.err);
  const named = () => landJobs(box).find(job => job.receipt?.returned?.some(row => row.reason === 'conflict'));
  // budget: hang ceiling for one loopback runner land job inside the file limit, never a speed assertion.
  await waitForCondition(() => Boolean(named()), 'the land job names the siblings\' conflict',
    { signal: AbortSignal.timeout(90_000), state: () => ({ jobs: landJobs(box), land: (landed.out + landed.err).slice(-400) }) });
  const job = named();
  assert.deepEqual([...job.items].sort((a, b) => a - b), entries.map(entry => entry.item), 'one land job carries both accepted siblings');
  // The job merges its items in order, so the sibling it merges first lands and the second is the one that collides.
  const [first, second] = job.items;
  assert.deepEqual(job.receipt.landed, [first], 'the first sibling lands');
  assert.deepEqual(job.receipt.returned.map(row => [row.id, row.reason]), [[second, 'conflict']], 'only the colliding sibling is returned');
  assert.match(job.receipt.returned[0].detail, new RegExp(`^#${second} does not merge on ${base.slice(0, 12)}: .*${file.replaceAll('.', '\\.')}`, 'su'),
    'the receipt names the colliding sibling, the shared main and its file');
  assert.equal(onBoard(box, board => store.getItem(board, second).item_merged_commit), null, `#${second} stays accepted and unmerged`);
  const trunk = box.git(box.repo, 'rev-parse', 'main');
  assert.equal(trunk, job.receipt.trunk, 'trunk moves to the composition the job pushed');
  assert.equal(job.receipt.base, base, 'the job composed on the main both reviews shared');
  assert.equal(box.git(box.repo, 'merge-base', base, trunk), base, 'the landed trunk builds on the main both reviews shared');
});
