import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { json } from '../../tests/fixtures/land/board.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { assertSiblingConflictLanding } from '../../../../packages/store/tests/fixtures/collision.js';
/** Sibling conflicts name themselves when reviews share the unchanged main, split from land/main for its file budget [B3,R3,E8]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { FILES, landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('land names sibling conflicts whose reviews share the unchanged main [B3,R3,E8]', () => {
  assertSiblingConflictLanding({ landProject, itemWorktree, submitItem, acceptItem, json, file: FILES[0] });
});
