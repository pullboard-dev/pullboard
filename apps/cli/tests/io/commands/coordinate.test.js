/** pullboard coordinate resumes the coordinator and prints how the person adds agents; it writes nothing, so twice is safe [C7,#8515]. */
/** @pullboard-world-pin reads the board and prints; a second run changes no board row [C7,#8515]. */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { apiHttpFixture } from '../../fixtures/api.js';
import { withFixtureBoard } from '../../fixtures/board.js';
import { runCliInProcess } from '../../fixtures/process.js';
import { addItem } from '../../../../../packages/store/index.js';
import { events } from '../../../../../packages/store/index.js';

/** The fixture repo's board file. */
const boardFile = box => join(box.root, '.git', 'pullboard', 'board.sqlite');

/** A fixture board with one open item in each of two lanes. */
function filed(t) {
  const box = apiHttpFixture(t);
  withFixtureBoard(boardFile(box), board => {
    addItem(board, { by: 'coordinator', lane: 'web', title: 'Page' });
    addItem(board, { by: 'coordinator', lane: 'api', title: 'Endpoint' });
  });
  return box;
}

test('clause 1: coordinate on a fixture board prints the resume state [C7,#8515]', async t => {
  const box = filed(t);
  const ran = await runCliInProcess(['coordinate'], { cwd: box.root, env: box.env });
  assert.equal(ran.status, 0, ran.stdout + ran.stderr);
  assert.match(ran.stdout, /^resume: coordinator/mu);
});

test('clause 2: coordinate prints how the person adds more agents, one worktree line per lane with open work [C7,#8515]', async t => {
  const box = filed(t);
  const ran = await runCliInProcess(['coordinate'], { cwd: box.root, env: box.env });
  assert.match(ran.stdout, /To add agents:/u);
  assert.match(ran.stdout, /pullboard worktree web --model/u);
  assert.match(ran.stdout, /pullboard worktree api --model/u);
  assert.match(ran.stdout, /each agent runs pullboard next/u);
});

test('clause 3: running coordinate twice is safe: the same card and no new board event [C7,#8515]', async t => {
  const box = filed(t);
  const first = await runCliInProcess(['coordinate'], { cwd: box.root, env: box.env });
  const count = () => withFixtureBoard(boardFile(box), board => events(board, {}).length);
  const before = count();
  const second = await runCliInProcess(['coordinate'], { cwd: box.root, env: box.env });
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.equal(second.stdout.split('\n').slice(1).join('\n'), first.stdout.split('\n').slice(1).join('\n'), 'the add-agents lines repeat');
  assert.equal(count(), before, 'the second run recorded nothing');
});
