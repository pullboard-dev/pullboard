/** Land blocks a stale accept and returns it to its lane, apart from bisect.test.js so each fits its file limit under pull [B3,R3,E8]. */
import assert from 'node:assert/strict';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../../tests/fixtures/land/project.js';
import { settleLand } from '../../../tests/fixtures/land/settle.js';
import { drainOwnedProcesses } from '../../../tests/fixtures/land/drain.js';
import { json } from '../../../tests/fixtures/land/board.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures(e2e);

test('land returns an accept whose reviewed file changed on main and lands the fresh one [B3,R3,E8]', async () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.slice(0, 2).map((file, index) => itemWorktree(box, index + 1, file));
  for (const entry of entries) submitItem(box, entry, 'PASS\n');
  for (const entry of entries) acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  assert.equal(commitFile(box, box.repo, FILES[1], 'different main content\n', 'chore: create a merge conflict').status, 0);
  await drainOwnedProcesses(box.dir);
  const result = await settleLand(box, json(box, box.repo, 'land'));
  assert.deepEqual(result.landed, [entries[0].item]);
  // The pulled land returns the stale accept to its lane before it offers the job.
  assert.equal(json(box, box.repo, 'show', String(entries[1].item)).item_status, 'open', 'the stale accept is withdrawn and the item reopens');
  const told = JSON.stringify(json(box, box.repo, 'show', String(entries[1].item)).thread);
  assert.match(told, /verdict stale: web\/land-2\.test\.js changed on main/u, 'the builder is told why');
  assert.equal(json(box, box.repo, 'show', String(entries[1].item)).item_merged_commit, null);
  assert.equal(box.git(box.remote, 'rev-parse', 'main'), result.batch.tip);
  await drainOwnedProcesses(box.dir);
  const again = await box.runLocal(box.repo, 'land', '--json');
  assert.ok(!again.out.includes('STALE_VERDICT'), `the stale accept was returned, so no stale refusal remains: ${again.out}`);
  await drainOwnedProcesses(box.dir);
});
