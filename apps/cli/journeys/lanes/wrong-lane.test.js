/** A claim refused WRONG_LANE names the lane and the command that opens a seat there, and opens nothing (GH #16, #27) [L2,B13]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crossLaneFixture } from '../../tests/fixtures/e2e.js';

test('WRONG_LANE with no free seat in that lane opens no worktree or seat and names the command that does [L2,B13]', t => {
  const box = crossLaneFixture(t);
  // Two seats of one agent session; neither is in the api lane, as with subagents of one coordinator session.
  const first = box.seat('wrong-lane-web-1', 'web', box.session);
  box.seat('wrong-lane-web-2', 'web', box.session);
  const id = box.add('api', 'Build only in the API lane');
  const worktreesBefore = box.git(box.repo, 'worktree', 'list', '--porcelain');
  const logBefore = box.run(box.repo, 'log').out;
  const wrong = box.runAs(box.session, first.root, 'claim', String(id), '--json');
  assert.equal(wrong.code, 1, wrong.out + wrong.err);
  const refusal = JSON.parse(wrong.out).error;
  assert.equal(refusal.code, 'WRONG_LANE');
  assert.match(refusal.message, /api lane/u, 'the refusal names the lane');
  assert.match(refusal.next, /pullboard worktree api --model /u, 'and the command that opens a seat there');
  assert.match(refusal.next, new RegExp(`pullboard claim ${id}$`, 'u'));
  assert.equal(box.git(box.repo, 'worktree', 'list', '--porcelain'), worktreesBefore, 'no worktree was created');
  assert.equal(box.run(box.repo, 'log').out, logBefore, 'no seat joined and nothing was recorded');
  assert.equal(box.json(box.run(box.repo, 'show', String(id), '--json')).item_status, 'open');
});
