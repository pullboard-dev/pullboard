/** A coordinator that takes over mid-batch and runs land --adopt lands without NOT_YOUR_CHECKOUT or LAND_DIRTY [B3,B7,R3]. */
import assert from 'node:assert/strict';
import {
  existsSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import {
  after,
  test,
} from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { startInterruptedLanding } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile, BIN } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('land --adopt after takeover rebinds the landing worktree to the new session [B3,B7,R3,GH24]', async (t) => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = [1, 2].map(number => itemWorktree(box, number));
  for (const entry of entries) submitItem(box, entry);
  for (const entry of entries) acceptItem(box, entry);
  delete box.env.LAND_SUPPRESS_RED;
  box.env.CODEX_THREAD_ID = 'coordinator-session-a';
  writeFileSync(box.hold, 'armed');
  const { child, closed, waitForGate } = startInterruptedLanding(box, BIN, t);
  await waitForGate();
  const batch = json(box, box.repo, 'resume').landingBatches.at(-1);
  const binding = join(box.git(batch.root, 'rev-parse', '--absolute-git-dir'), 'pullboard-checkout-session.json');
  // The landing's own commits in its worktree run the repository hooks, which bind the worktree to the committing session.
  box.tryGit(batch.root, 'commit', '-q', '--allow-empty', '-m', 'chore(doctrine): record lower held counts [G1]');
  assert.ok(existsSync(binding), 'the first session bound the landing worktree through a hook');
  process.kill(-child.pid, 'SIGKILL');
  await closed;
  writeFileSync(box.release, 'release');
  box.env.CODEX_THREAD_ID = 'coordinator-session-b';
  assert.equal(box.run(box.repo, 'takeover').code, 0, 'the new session takes over the main checkout');
  const adopted = json(box, box.repo, 'land', '--adopt');
  assert.deepEqual(adopted.landed, entries.map(entry => entry.item));
  assert.equal(json(box, box.repo, 'resume').landingBatches.at(-1).state, 'landed');
});
