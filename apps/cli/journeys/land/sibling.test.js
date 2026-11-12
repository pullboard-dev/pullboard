/** Sibling items that collide on one file: the first lands by its runner land job and the second's job names the conflict, apart from main.test.js so each fits its file limit under pull [B3,R3,E8]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { landJobs } from '../../tests/fixtures/land/board.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { waitForCondition } from '../../tests/fixtures/runner/holders.js';
import { fixtureJoin } from '../../tests/fixtures/testkit.js';
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('land names sibling conflicts whose reviews share the unchanged main [B3,R3,E8]', async () => {
  const box = landProject();
  const file = FILES[0];
  const entries = [1, 2].map(number => itemWorktree(box, number, file));
  submitItem(box, entries[0], 'PASS\n// first sibling\n');
  submitItem(box, entries[1], 'PASS\n// second sibling\n');
  const merged = id => onBoard(box, board => store.getItem(board, id).item_merged_commit);
  const state = () => ({ jobs: landJobs(box), items: entries.map(entry => onBoard(box, board => store.getItem(board, entry.item).item_status)) });
  const conflicted = () => landJobs(box).some(job => job.items.includes(entries[1].item) && job.receipt?.outcome === 'conflict');
  // A reviewer accepts from its own checkout, so the main checkout stays on its branch and the ACCEPT offers a land job;
  // the second accept waits for the first job's receipt, since an open land job takes no second automatic offer [P7].
  for (const [index, entry] of entries.entries()) {
    const reviewer = join(box.dir, `sibling-reviewer-${index + 1}`);
    box.git(box.repo, 'worktree', 'add', '-q', '--detach', reviewer, entry.commit);
    assert.equal((await fixtureJoin(box.runLocal, reviewer, 'web', '--model', 'sibling-reviewer')).code, 0);
    const accepted = await box.runLocal(reviewer, 'verify', String(entry.item), 'accept', '--note', 'private sibling fixture check passed');
    assert.equal(accepted.code, 0, accepted.out + accepted.err);
    // budget: hang ceiling for one loopback runner land job inside the file limit, never a speed assertion.
    await waitForCondition(index === 0 ? () => Boolean(merged(entry.item)) : conflicted, `#${entry.item}'s land job posts its receipt`,
      { signal: AbortSignal.timeout(60_000), state });
  }
  assert.match(merged(entries[0].item) ?? '', /^[0-9a-f]{40}$/u, 'the first sibling lands by its runner land job');
  assert.equal(box.git(box.repo, 'show', `main:${file}`), 'PASS\n// first sibling', 'trunk holds the first sibling');
  assert.equal(merged(entries[1].item), null, 'the colliding sibling stays accepted and unmerged');
  const jobs = landJobs(box);
  const named = jobs.find(job => job.items.includes(entries[1].item) && job.receipt?.outcome === 'conflict');
  assert.ok(named, `a land job names #${entries[1].item}'s conflict: ${JSON.stringify(jobs)}`);
  assert.match(named.receipt.detail, new RegExp(`^#${entries[1].item} does not merge on [0-9a-f]{12}: .*${file.replaceAll('.', '\\.')}`, 'su'),
    'the receipt names the colliding sibling and its file');
});
