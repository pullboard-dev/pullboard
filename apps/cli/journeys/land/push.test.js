import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { events } from '../../tests/fixtures/land/board.js';
import { calls } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { mergeSubjects } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { settleLand } from '../../tests/fixtures/land/settle.js';
import { whenRunnerSettles } from '../../tests/fixtures/runner/local-start.js';
/** Exercise landing pushes and diagnostics against real private Git worktrees [B3,R3,C7]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('land pushes one exact batch in verdict order and records each first-containing merge once [B3,R3]', async () => {
  const box = landProject();
  // Three items are enough to show verdict order differs from item order; a fourth only adds a pulled gate to this file's time.
  box.env.LAND_SUPPRESS_RED = '1';
  const entries = FILES.slice(0, 3).map((file, index) => itemWorktree(box, index + 1, file));
  for (const entry of entries) submitItem(box, entry, 'PASS\n');
  for (const index of [2, 0, 1]) acceptItem(box, entries[index]);
  delete box.env.LAND_SUPPRESS_RED;
  const base = box.git(box.repo, 'rev-parse', 'main');
  const start = calls(box).length;
  const result = await settleLand(box, json(box, box.repo, 'land'));
  const order = [2, 0, 1].map((index) => entries[index].item);
  assert.deepEqual(result.landed, order);
  assert.deepEqual(mergeSubjects(box, base, result.batch.tip), [3, 1, 2].map((n) => `feat(merge): land fixture ${n} [G1]`), 'each merge takes its item\'s type from the item\'s feat commit');
  assert.equal(result.batch.state, 'landed');
  assert.equal(box.git(box.repo, 'rev-parse', 'main'), result.batch.tip);
  await whenRunnerSettles(box.env, () => box.git(box.remote, 'rev-parse', 'main') === result.batch.tip, { deadlineMs: 30_000, what: 'origin to take the landed tip' }); // the land job publishes the host trunk's tip on to origin [#7398]
  assert.deepEqual(calls(box).slice(start), [], 'the land job proves the batch from its items\' gate rows in the ledger; no gate runs again');
  const merges = box.git(box.repo, 'rev-list', '--reverse', '--first-parent', `${base}..${result.batch.tip}`).split('\n');
  for (const [index, id] of order.entries()) assert.equal(json(box, box.repo, 'show', String(id)).item_merged_commit, merges[index]);
  for (const [index, id] of order.entries()) assert.equal(box.git(box.repo, 'log', '-1', '--format=%b', merges[index]).trim(), `Pullboard-Item: #${id}\nPullboard-Rows: G1`, 'each train merge body is only its trailers, naming no lane branch');
  const receipt = events(box).filter((event) => event.event_kind === 'main-moved');
  assert.equal(receipt.length, 1);
  assert.equal(JSON.parse(receipt[0].event_detail).sha, result.batch.tip);
  const eventCount = events(box).length;
  assert.deepEqual((await settleLand(box, json(box, box.repo, 'land'))).landed ?? [], []);
  assert.equal(events(box).length, eventCount, 'second invocation writes no duplicate receipts');
  assert.deepEqual(calls(box).slice(start), [], 'second invocation runs no tests');
  const lane = box.run(entries[0].path, 'land', '--json');
  assert.equal(JSON.parse(lane.out).error?.code, 'COORDINATOR_ONLY');
});

// CONTROLLER_ONLY: the focused diagnosis inherits the controller's gate-slot lease and reads the batch log of an in-process landing (batch.state 'flaky', batch.logPath); the pulled land job holds no controller lease [C7].
test('land diagnostics inherit their browser gate lease [C7]', { skip: 'CONTROLLER_ONLY: deleted with #6807' }, () => {});
