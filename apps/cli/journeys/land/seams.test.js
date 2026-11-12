import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { landEnginesInOrder } from '../../tests/fixtures/land/engine.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
/** Exercise engine numbering against real private Git worktrees [B3,R3,H16]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('the landing merge assigns engine numbers in landing order, either order, and the board replays [B3,R3,H16]', () => {
  for (const order of [[0, 1], [1, 0]]) landEnginesInOrder({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }, order);
});
