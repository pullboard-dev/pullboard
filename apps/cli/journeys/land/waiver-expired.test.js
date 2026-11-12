import assert from 'node:assert/strict';
import { after } from 'node:test';
import { test } from 'node:test';
import * as store from '../../../../packages/store/index.js';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { calls } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
/** Exercise an expired landing waiver against real private Git worktrees, split from the adoption journey to keep each file inside its time budget [B3,R3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem, moveMainPastSubmit } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('land stops again with an expired waiver, and a changed test on main releases the held batch [B3,R3]', () => {
  const box = landProject();
  box.env.LAND_SUPPRESS_RED = '1';
  assert.equal(commitFile(box, box.repo, FILES[0], 'FLAKE\n', 'chore: install a flaky fixture test').status, 0);
  const entry = itemWorktree(box, 1, 'web/feature.js');
  submitItem(box, entry);
  acceptItem(box, entry);
  // The submit's green receipt would cover a landing on its own main, so move main past it and let the landing gate run [#3685].
  moveMainPastSubmit(box);
  delete box.env.LAND_SUPPRESS_RED;
  const held = json(box, box.repo, 'land');
  assert.equal(held.batch.state, 'flaky');
  const past = { now: () => new Date('2000-01-01T00:00:00Z') };
  onBoard(box, (board) => store.recordLandingWaiver(board, { agentId: 'person', channel: 'terminal', id: 'expired-example', test: FILES[0], until: '2000-01-02', reason: 'expired fixture approval' }), past);
  const start = calls(box).length;
  // Lander v2 (#5862) retires a held flaky batch instead of refusing LAND_FLAKE, so the expired waiver lets
  // nothing through: land gates the composition afresh, the flake holds it again and nothing lands.
  const again = json(box, box.repo, 'land');
  assert.equal(again.batch.state, 'flaky');
  assert.deepEqual(again.landed, []);
  assert.notEqual(again.batch.id, held.batch.id, 'the retired batch is replaced by a fresh one');
  const regated = calls(box).length;
  assert.ok(regated > start, 'the expired waiver excuses nothing: the composition is gated afresh');
  assert.equal(commitFile(box, box.repo, FILES[0], 'PASS\n', 'chore: correct the flaky test').status, 0);
  const landed = json(box, box.repo, 'land');
  assert.deepEqual(landed.landed, [entry.item]);
  assert.notEqual(landed.batch.id, held.batch.id);
  assert.equal(landed.batch.proof.failures.length, 0);
  assert.deepEqual(calls(box).slice(regated), [[]], 'corrected test is gated afresh');
});
