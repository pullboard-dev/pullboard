import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { assertNoRemoteLanding } from '../../tests/fixtures/land/remote.js';
import { assertLandingStopIdentity } from '../../tests/fixtures/land/stop.js';
/** Exercise landing basics against real private Git worktrees [B3,R3]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, commitFile } = e2e;

test('a landing stop never signals a reused process group [Q1,Q3,C7]', async () => {
  await assertLandingStopIdentity();
});

// The doctrine-count case went with the host landing batch: a runner land job merges and checks, and the batch's count
// tightening is not part of it; L6e deletes that engine (#6119), so it is no longer journeyed here [P7,#6577].

test('a repo with no remote lands into the local trunk and status reads as normal [I1,B3,R3,H5]', async () => {
  await assertNoRemoteLanding(sandbox, commitFile);
});
/** Keep the complete private diagnostic refusal in a failing assertion before fixture cleanup deletes its logs. */
