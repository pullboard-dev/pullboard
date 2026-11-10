/** Unknown vendor registration and historical verdict snapshots keep separate review contracts [O2,O3,V4,H16]. */
import assert from 'node:assert/strict';
import * as store from '../../../../../packages/store/index.js';
import { REVIEW_INDEPENDENCE_ENGINE } from '../../../../../packages/state/light.js';

/** Prove fresh refusal without writes, then preserve the predecessor's null-family native verdict. */
export function verifyLegacyUnknownFamily(board, id, options) {
  const beforePolicy = store.lineSettings(board).requireReviewFamilies;
  requireFixtureReviewFamilies(board);
  const before = store.events(board);
  assert.throws(() => store.verify(board, id, options), { code: 'O2_FAMILY_MATCH' },
    'a registered unknown-family seat cannot issue a fresh verdict');
  assert.deepEqual(store.events(board), before, 'a refused fresh review writes no event');
  const prior = board.executionEngineVersion;
  board.executionEngineVersion = REVIEW_INDEPENDENCE_ENGINE - 1;
  try { return store.verify(board, id, options); }
  finally {
    if (prior === undefined) delete board.executionEngineVersion; else board.executionEngineVersion = prior;
    store.setLineSetting(board, { agentId: 'coordinator', key: 'requireReviewFamilies', value: beforePolicy,
      reason: 'Restore the private fixture policy after its setting-on refusal control.', window: { syntheticPolicy: 1 } });
  }
}


/** Select the setting-on path explicitly in private fixtures, leaving unknown-parent controls unchanged. */
export function requireFixtureReviewFamilies(board) {
  store.setLineSetting(board, { agentId: 'coordinator', key: 'requireReviewFamilies', value: true,
    reason: 'Private fixture explicitly requires declared vendor pairs; this changes no operational board.',
    window: { syntheticPolicy: 1 } });
}

/**
 * Freeze the real spec row shape that `show` renders for the family integration fixture.
 *
 * @returns {{ text: string, digest: string }}
 */
export function familyFreeze() {
  return {
    text: JSON.stringify({ rows: [{ id: 'G1', text: 'Families are recorded.', gate: 'true' }] }),
    digest: 'digest:family',
  };
}
