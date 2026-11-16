/** pullboard coordinate confirms the listener is armed and names the builder and verifier starts [C7,#8516]. */
/** @pullboard-world-pin reads the board and prints; nothing is written [C7,#8516]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../../fixtures/api.js';
import { withFixtureBoard } from '../../../fixtures/board.js';
import { runCliInProcess } from '../../../fixtures/process.js';
import { addItem } from '../../../../../../packages/store/index.js';

/** A fixture board with one open item in the web lane. */
function filed(t) {
  const box = apiHttpFixture(t);
  withFixtureBoard(join(box.root, '.git', 'pullboard', 'board.sqlite'), board => addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' }));
  return box;
}

test('clause 1: coordinate confirms the listener is armed and what wakes it [C7,#8516]', async t => {
  const box = filed(t);
  const ran = await runCliInProcess(['coordinate'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /listener armed: pullboard inbox is the feed; it wakes you on each new shout to coordinator, all or person/u);
  assert.match(ran.stdout, /each decision or request on an item thread, and each reject/u);
});

test('clause 2: coordinate names the builder start per lane and the verifier start as a separate session [C7,#8516]', async t => {
  const box = filed(t);
  const ran = await runCliInProcess(['coordinate'], { cwd: box.root, env: box.env });
  assert.match(ran.stdout, /builder \(web\): pullboard worktree web --model/u);
  assert.match(ran.stdout, /verifier: pullboard worktree review --model .*separate session, never your subagent/u);
});
