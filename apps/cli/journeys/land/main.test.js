import { test } from 'node:test';
import { assertLandingStopIdentity } from '../../tests/fixtures/land/stop.js';
/** Exercise landing basics against real private Git worktrees [B3,R3]. */

test('a landing stop never signals a reused process group [Q1,Q3,C7]', async () => {
  await assertLandingStopIdentity();
});
