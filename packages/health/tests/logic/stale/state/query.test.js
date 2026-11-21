/** The idle claim release limit is 30 minutes, matching the release table and the store re-check [C7,#12468]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CLAIM_IDLE_RELEASE_MS } from '../../../../src/logic/stale/state/query.js';

test('health.logic-stale-state-query.idle-release-30: clause 1: CLAIM_IDLE_RELEASE_MS equals 30 * 60_000 [C7,#12468,clause 1]', () => {
  assert.equal(CLAIM_IDLE_RELEASE_MS, 30 * 60_000);
});
