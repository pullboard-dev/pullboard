import { after } from 'node:test';
import { test } from 'node:test';
import { createE2eHelpers } from '../../tests/fixtures/e2e.js';
import { makeLandProjectFixtures } from '../../tests/fixtures/land/project.js';
import { assertLocalWaiverExpiry } from '../../tests/fixtures/land/expiry.js';
import { assertAffectedLandingUnstamped } from '../../tests/fixtures/land/deferred.js';
import { assertDeferredBatchIsolation } from '../../tests/fixtures/land/deferred.js';
/** Exercise shared-importer isolation and local-trunk waivers against real private Git worktrees [B3,R3,C7,V4]. */
const e2e = createE2eHelpers();
after(e2e.cleanup);
const { sandbox, project, commitFile } = e2e;
const { landProject, itemWorktree, submitItem, acceptItem } = makeLandProjectFixtures({ sandbox, project, commitFile });

test('a deferred red shared importer returns only its culprit and lands innocent owners locally [B3,R3,C7,V4]', { timeout: 120_000 }, // budget: four real submit/accept cycles and shared-importer isolation; hang ceiling only.
() => assertDeferredBatchIsolation({ landProject, itemWorktree, submitItem, acceptItem }));

test('a green affected-only local landing never stamps the full gate [B3,R3,C7,V4]', { timeout: 90_000 }, // budget: one real submit/accept and finite affected landing; hang ceiling only.
() => assertAffectedLandingUnstamped({ landProject, itemWorktree, submitItem, acceptItem }));

for (const seam of ['live', 'trunk-save', 'finish-lease']) {
  test(`local-trunk waived red retains live authorization at ${seam} [B3,R3]`, { timeout: 90_000 }, () => {
    assertLocalWaiverExpiry({ landProject, itemWorktree, submitItem, acceptItem }, seam);
  });
}
