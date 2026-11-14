/** @pullboard-test-loads apps/cli/tests/fixtures/landing/loader.js */
/** Kill a runner's land job recording, after its push and before its receipt; once its lease expires a second runner finishes both items [B35,P7]. */
import { test } from 'node:test';
import { boardJobQueueCall } from '../../../../../../packages/api/index.js';
import { jobsOf } from '../../../../../../packages/jobs/index.js';
import { LEASE_MS } from '../../../../../../packages/jobs/index.js';
import { getItem } from '../../../../../../packages/store/index.js';
import { pulledDrillCase } from '../../../../tests/fixtures/landing/drill.js';

test('killing a runner during its land job\'s recording lets a second runner take the job after the lease expires and land both items [B35,P7]', { timeout: 300_000 }, // budget: hang ceiling for a project, two submits, two pulled gates and two runner landings.
  pulledDrillCase('recording', { getItem, jobsOf, LEASE_MS, boardJobQueueCall }));
