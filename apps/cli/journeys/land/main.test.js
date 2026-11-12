import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { assertNoRemoteLanding } from '../../tests/fixtures/land/remote.js';
import { assertLandingStopIdentity } from '../../tests/fixtures/land/stop.js';
import assert from 'node:assert/strict';
import { landJobs } from '../../tests/fixtures/land/board.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import * as store from '../../../../packages/store/index.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
/** Exercise landing basics against real private Git worktrees [B3,R3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a landing stop never signals a reused process group [Q1,Q3,C7]', async () => {
  await assertLandingStopIdentity();
});

// The doctrine-count case went with the host landing batch: a runner land job merges and checks, and the batch's count
// tightening is not part of it; L6e deletes that engine (#6119), so it is no longer journeyed here [P7,#6577].

test('a repo with no remote lands into the local trunk and status reads as normal [I1,B3,R3,H5]', () => {
  assertNoRemoteLanding(sandbox, commitFile);
});
/** Prepare four independent submitted items and accept them in a caller-selected verdict order. */

test('land names sibling conflicts whose reviews share the unchanged main [B3,R3,E8]', () => {
  const box = landProject();
  const file = FILES[0];
  const entries = [1, 2].map(number => itemWorktree(box, number, file));
  submitItem(box, entries[0], 'PASS\n// first sibling\n');
  submitItem(box, entries[1], 'PASS\n// second sibling\n');
  for (const entry of entries) acceptItem(box, entry);
  const merged = id => onBoard(box, board => store.getItem(board, id).item_merged_commit);
  assert.match(merged(entries[0].item) ?? '', /^[0-9a-f]{40}$/u, 'the first sibling lands by its runner land job');
  assert.equal(box.git(box.repo, 'show', `main:${file}`), 'PASS\n// first sibling', 'trunk holds the first sibling');
  assert.equal(merged(entries[1].item), null, 'the colliding sibling stays accepted and unmerged');
  const jobs = landJobs(box);
  const named = jobs.find(job => job.items.includes(entries[1].item) && job.receipt?.outcome === 'conflict');
  assert.ok(named, `a land job names #${entries[1].item}'s conflict: ${JSON.stringify(jobs)}`);
  assert.match(named.receipt.detail, new RegExp(`^#${entries[1].item} does not merge on [0-9a-f]{12}: .*${file.replaceAll('.', '\\.')}`, 'su'),
    'the receipt names the colliding sibling and its file');
});

/** Keep the complete private diagnostic refusal in a failing assertion before fixture cleanup deletes its logs. */
