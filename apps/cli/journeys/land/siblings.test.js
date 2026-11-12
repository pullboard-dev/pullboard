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
  // Both reviews share the unchanged main; the hand landing offers them as one runner land job, which merges #1 and
  // names #2's collision in its receipt, so the job lands neither and trunk stays where both reviews saw it [P7].
  const landed = await box.runLocal(box.repo, 'land');
  assert.equal(landed.code, 0, landed.out + landed.err);
  const named = () => landJobs(box).find(job => job.items.includes(entries[1].item) && job.receipt?.outcome === 'conflict');
  // budget: hang ceiling for one loopback runner land job inside the file limit, never a speed assertion.
  await waitForCondition(() => Boolean(named()), `the land job names #${entries[1].item}'s conflict`,
    { signal: AbortSignal.timeout(90_000), state: () => ({ jobs: landJobs(box), land: (landed.out + landed.err).slice(-400) }) });
  const job = named();
  assert.deepEqual(job.items, entries.map(entry => entry.item), 'one land job carries both accepted siblings');
  assert.match(job.receipt.detail, new RegExp(`^#${entries[1].item} does not merge on ${base.slice(0, 12)}: .*${file.replaceAll('.', '\\.')}`, 'su'),
    'the receipt names the colliding sibling, the shared main and its file');
  for (const entry of entries) assert.equal(onBoard(box, board => store.getItem(board, entry.item).item_merged_commit), null, `#${entry.item} stays accepted and unmerged`);
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), base, 'trunk stays on the main both reviews shared');
});
