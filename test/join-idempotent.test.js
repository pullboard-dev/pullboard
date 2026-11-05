/** A same-seat, same-lane and same-model join is harmless to repeat [C7]. */
import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { join } from 'node:path';
import { createE2eHelpers } from './e2e-helpers.js';

const e2e = createE2eHelpers();
after(e2e.cleanup);

test('same lane and model rejoin exits 0; a different lane or model still refuses [C7]', () => {
  const box = e2e.project('true', undefined, { withWorktree: false });
  const worktree = join(box.dir, 'joined-seat');
  box.git(box.repo, 'worktree', 'add', '-q', worktree, '-b', 'web/join-idempotent');
  const first = box.run(worktree, 'join', 'web', '--model', 'Fixture');
  assert.equal(first.code, 0, first.err);
  const again = box.run(worktree, 'join', 'web', '--model', 'Fixture');
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already joined as web-1 \(Fixture\); run pullboard next/u);
  assert.equal(JSON.parse(box.run(worktree, 'join', 'web', '--model', 'Fixture', '--json').out).agent, 'web-1');

  const otherLane = box.run(worktree, 'join', 'api', '--model', 'Fixture');
  assert.notEqual(otherLane.code, 0);
  assert.match(otherLane.err, /ALREADY_JOINED/u);
  const otherModel = box.run(worktree, 'join', 'web', '--model', 'Another Fixture');
  assert.notEqual(otherModel.code, 0);
  assert.match(otherModel.err, /ALREADY_JOINED/u);
});
