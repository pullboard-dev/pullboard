import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { assertNoRemoteLanding } from '../../tests/fixtures/land/remote.js';
import { assertLandingStopIdentity } from '../../tests/fixtures/land/stop.js';
import { assertLandingDoctrineCounts } from '../../tests/fixtures/land/doctrine.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
/** Exercise landing basics against real private Git worktrees [B3,R3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a landing stop never signals a reused process group [Q1,Q3,C7]', async () => {
  await assertLandingStopIdentity();
});

test('a landing records a falling doctrine count and holds a rising count [B3,R3,D1,D3]', () => {
  assertLandingDoctrineCounts({ landProject, itemWorktree, submitItem, acceptItem });
});

test('a repo with no remote lands into the local trunk and status reads as normal [I1,B3,R3,H5]', () => {
  assertNoRemoteLanding(sandbox, commitFile);
});
