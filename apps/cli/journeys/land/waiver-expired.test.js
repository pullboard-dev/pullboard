import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
/** Exercise an expired landing waiver against real private Git worktrees, split from the adoption journey to keep each file inside its time budget [B3,R3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('land stops again with an expired waiver, and a changed test on main releases the item [B3,R3]', { timeout: 300_000 }, // budget: two real pulled landings and one resubmit; hang ceiling only.
async () => {
  const box = landProject();
  // The project's default shape: no affectedTests, so the land job runs the whole gate on the merged tree [P7].
  const path = join(box.repo, 'pullboard.json');
  const config = JSON.parse(readFileSync(path, 'utf8'));
  delete config.affectedTests;
  writeFileSync(path, JSON.stringify(config, null, 2));
  box.git(box.repo, 'commit', '-q', '-am', 'chore: the init default has no affectedTests');
  box.env.LAND_SUPPRESS_RED = '1';
  assert.equal(commitFile(box, box.repo, FILES[0], 'FLAKE\n', 'chore: install a flaky fixture test').status, 0);
  const entry = itemWorktree(box, 2);
  submitItem(box, entry);
  acceptItem(box, entry);
  // The submit's green receipt would cover a landing on its own main, so move main past it and let the landing gate run [#3685].
  moveMainPastSubmit(box);
  delete box.env.LAND_SUPPRESS_RED;
  const past = { now: () => new Date('2000-01-01T00:00:00Z') };
  onBoard(box, (board) => store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-example', test: FILES[0], until: '2000-01-02', reason: 'expired fixture approval' }), past);
  const main = box.git(box.repo, 'rev-parse', 'main');
  // The expired waiver excuses nothing: the land job runs the gate, the flaky test holds it red and nothing lands.
  const held = await settleLand(box, json(box, box.repo, 'land'));
  assert.equal(held.batch.state, 'blocked', JSON.stringify(held.landJob));
  assert.deepEqual(held.landed, []);
  assert.match(String(held.landJob.receipt.detail), /land-1\.test\.js/u, 'the red names the flaky test the expired waiver no longer covers');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), main, 'main keeps its tree');
  assert.equal(onBoard(box, (board) => store.getItem(board, entry.item).item_status), 'open', 'the red item returns to its builder');
  // Correcting the test on main releases the item: rebuilt and accepted again, it lands.
  assert.equal(commitFile(box, box.repo, FILES[0], 'PASS\n', 'chore: correct the flaky test').status, 0);
  assert.equal(box.run(entry.path, 'claim', String(entry.item)).code, 0);
  submitItem(box, entry, 'PASS again\n');
  acceptItem(box, entry);
  const landed = await settleLand(box, json(box, box.repo, 'land'));
  assert.deepEqual(landed.landed, [entry.item], JSON.stringify(landed.landJob));
  assert.equal(landed.batch.state, 'landed');
});
