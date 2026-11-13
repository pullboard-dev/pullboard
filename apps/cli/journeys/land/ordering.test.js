import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { onBoard } from '../../tests/fixtures/land/board.js';
import { json } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { assertCollisionFreeLanding } from '../../../../packages/store/tests/fixtures/collision.js';
import { assertDeferredLandingPriority } from '../../../../packages/store/tests/fixtures/collision.js';
/** Exercise landing batch ordering against real private Git worktrees [B3,R3,R1,H16]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a landing batch leaves out an item that touches a file already in the batch [B3,R3,R1,H16]',
() => assertCollisionFreeLanding({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }));

test('a deferred landing item keeps its place ahead of newer acceptances after merge-only reaccept [B3,R3,R1,H16]',
() => assertDeferredLandingPriority({ landProject, itemWorktree, submitItem, acceptItem, json, onBoard }));
