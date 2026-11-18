/** @pullboard-test-input source-cell packages/moves */
/** The release table holds an item whose review one family releases twice without a verdict, only behind io.holdAfterTwoReleases and the review-release-twice engine [C7,#10929]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseEngine } from '../../index.js';
import { runTable } from '../../index.js';

const FROM = 30;
const { rules: RULES, table: TABLE } = releaseEngine({
  reasons: ['INELIGIBLE', 'ROUTED_ELSEWHERE', 'BLOCKED', 'BUDGET', 'TAKEN_OVER', 'DIAGNOSIS_WRONG', 'INFRA', 'OTHER'],
  staleLimits: () => ({ claim: 3_600_000, blocker: 900_000 }),
  reviewReleaseTwiceEngine: FROM,
});
const NOW = '2026-11-18T12:00:00.000Z';
const REVIEWER = 'core-2';

/** A submitted item whose review `REVIEWER` holds, after one earlier review release since the latest submit. */
function snapshot({ io = { holdAfterTwoReleases: true }, engine = FROM, family = 'openai', earlier = [{ by: 'core-3', family: 'openai', reason: 'cannot judge this' }], holdReason = null } = {}) {
  return {
    ...(engine === undefined ? {} : { engine }),
    revision: 4, actor: { id: REVIEWER, route: 'light', joined: true, family }, owner: null, diagnosed: false, firstRefusalBuilder: null,
    item: { id: 7, status: 'submitted', owner: null, route: 'light', after: [], leaseUntil: null, holdReason, holdBy: holdReason ? 'coordinator' : null, reviewer: REVIEWER },
    items: { 7: { status: 'submitted', after: [] } },
    history: [{ id: 1, kind: 'claim', by: 'core-1', detail: {} }, { id: 2, kind: 'submit', by: 'core-1', detail: {} }],
    ownerLastClaimId: 1, ownerLastLease: null, ownerRegisteredPath: '/seats/core-1', lastClaim: { id: 1, kind: 'claim', by: 'core-1', detail: {} },
    io, ...(earlier === null ? {} : { reviewReleases: earlier }),
  };
}

const release = { id: 7, actor: REVIEWER, root: '/seats/core-2', reason: 'OTHER', note: 'no time to judge', now: NOW, worktreeSnapshot: { head: 'h', digest: 'd' } };
const run = (s, m = release) => runTable(TABLE, RULES, structuredClone(s), structuredClone(m));

test('moves.release.review-twice-hold: clause 1: a second review release since the latest submit by the first releaser\'s family, with io.holdAfterTwoReleases on at the engine, becomes a coordinator hold_item event that names both releases [C7,#10929]', () => {
  const result = run(snapshot());
  assert.equal(result.refused, undefined);
  assert.deepEqual(result.via, ['free-review', 'review-released-twice']);
  const reason = 'Review released twice without a verdict: core-3 (cannot judge this); core-2 (no time to judge)';
  assert.deepEqual(result.patch, { reviewer: null, holdReason: reason, holdBy: 'coordinator' });
  assert.deepEqual(result.events.map(event => event.kind), ['release', 'hold_item']);
  assert.deepEqual(result.events[1], { kind: 'hold_item', by: 'coordinator', detail: { reason, automatic: 'review-release-twice' } });
  assert.equal(run(snapshot({ engine: FROM + 4 })).via.at(-1), 'review-released-twice', 'a later engine holds too');
  assert.equal(run(Object.fromEntries(Object.entries(snapshot()).filter(([key]) => key !== 'engine'))).via.at(-1), 'review-released-twice', 'a hand-built snapshot with no engine is current');
  const three = run(snapshot({ earlier: [{ by: 'core-5', family: 'anthropic', reason: 'x' }, { by: 'core-3', family: 'openai', reason: 'cannot judge this' }] }));
  assert.match(three.patch.holdReason, /core-3 \(cannot judge this\); core-2/u, 'the earlier release of the same family is the one named');
});

test('moves.release.review-twice-off: clause 2: with the setting off or absent, below the engine, on a held item, or with releases by two families, a review release only frees the review [C7,#10929]', () => {
  const frees = (s, why) => {
    const result = run(s);
    assert.equal(result.refused, undefined, why);
    assert.deepEqual(result.via, ['free-review'], why);
    assert.deepEqual(result.patch, { reviewer: null }, why);
    assert.deepEqual(result.events.map(event => event.kind), ['release'], why);
  };
  frees(snapshot({ io: { holdAfterTwoReleases: false } }), 'setting off');
  frees(snapshot({ io: {} }), 'setting absent');
  frees(snapshot({ engine: FROM - 1 }), 'below the engine');
  frees(snapshot({ engine: null }), 'a record with no engine stamp is older');
  frees(snapshot({ holdReason: 'held already' }), 'already held');
  frees(snapshot({ earlier: [{ by: 'core-3', family: 'anthropic', reason: 'x' }] }), 'two families');
  frees(snapshot({ earlier: [] }), 'a first review release');
  frees(snapshot({ earlier: null }), 'no review release list');
  frees(snapshot({ family: null }), 'an unknown releaser family');
});
