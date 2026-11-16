/** @pullboard-test-input source-cell packages/moves */
/** Untouched INELIGIBLE and ROUTED_ELSEWHERE hand-backs count toward the release-twice reroute only with release.rerouteUntouched on [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseEngine } from '../../../index.js';
import { runTable } from '../../../index.js';

const { rules: RULES, table: TABLE } = releaseEngine({
  reasons: ['INELIGIBLE', 'ROUTED_ELSEWHERE', 'BLOCKED', 'BUDGET', 'TAKEN_OVER', 'DIAGNOSIS_WRONG', 'INFRA', 'OTHER'],
  staleLimits: () => ({ claim: 3_600_000, blocker: 900_000 }),
});
const NOW = '2026-11-16T12:00:00.000Z';
const HOLDER = 'core-1';
const NEXT_STATE = { head: 'h1', digest: 'd1' };

/**
 * A claimed item at the light route whose holder already handed it back once with `first`, then claimed it again.
 * `firstUntouched` says whether that earlier hand-back left the worktree exactly as next did.
 */
function snapshot({ first, firstUntouched, reroute }) {
  const history = [
    { id: 1, kind: 'claim', by: HOLDER, detail: {} },
    { id: 2, kind: 'release', by: HOLDER, detail: { reasonCode: first, ...(firstUntouched ? { untouchedAutoClaim: true } : {}) } },
    { id: 3, kind: 'claim', by: HOLDER, detail: { autoNextSnapshot: NEXT_STATE } },
  ];
  return {
    revision: 3, actor: { id: HOLDER, route: 'light', joined: true }, owner: null, diagnosed: false, firstRefusalBuilder: null,
    item: { id: 7, status: 'claimed', owner: HOLDER, route: 'light', after: [], leaseUntil: '2026-11-16T13:00:00.000Z', holdReason: null, holdBy: null, reviewer: null },
    items: { 7: { status: 'claimed', after: [] } }, history, ownerLastClaimId: 3, ownerLastLease: null, ownerRegisteredPath: '/seats/core-1',
    lastClaim: { id: 3, kind: 'claim', by: HOLDER, detail: { autoNextSnapshot: NEXT_STATE } },
    io: reroute === undefined ? {} : { rerouteUntouched: reroute },
  };
}

/** The second hand-back, untouched or touched, with the given reason. */
function release(reason, untouched) {
  return { id: 7, actor: HOLDER, root: '/seats/core-1', reason, note: 'x', now: NOW,
    worktreeSnapshot: untouched ? { ...NEXT_STATE } : { head: 'h1', digest: 'changed' } };
}

const run = (s, m) => runTable(TABLE, RULES, structuredClone(s), structuredClone(m));

test('clause 1: two untouched releases with INELIGIBLE or ROUTED_ELSEWHERE reroute the item one route up when release.rerouteUntouched is on [C7]', () => {
  for (const first of ['INELIGIBLE', 'ROUTED_ELSEWHERE']) {
    for (const second of ['INELIGIBLE', 'ROUTED_ELSEWHERE']) {
      const result = run(snapshot({ first, firstUntouched: true, reroute: true }), release(second, true));
      assert.equal(result.refused, undefined, `${first} then ${second}`);
      assert.ok(result.via.includes('released-twice'), `${first} then ${second} reroutes`);
      assert.equal(result.patch.route, 'mid', `${first} then ${second} moves one route up`);
      assert.ok(result.events.some(event => event.kind === 'escalate' && event.detail.to === 'mid'), 'the move is recorded as an escalation');
    }
  }
});

test('clause 1: with the setting off or unset, untouched releases never reroute [C7]', () => {
  for (const reroute of [false, undefined]) {
    const result = run(snapshot({ first: 'INELIGIBLE', firstUntouched: true, reroute }), release('INELIGIBLE', true));
    assert.equal(result.refused, undefined);
    assert.deepEqual(result.via, ['return-claim']);
    assert.equal(result.patch.route, undefined);
  }
});

test('clause 1: a touched ROUTED_ELSEWHERE release, or an untouched release with any other reason, does not reroute [C7]', () => {
  const touched = run(snapshot({ first: 'ROUTED_ELSEWHERE', firstUntouched: false, reroute: true }), release('ROUTED_ELSEWHERE', false));
  assert.deepEqual(touched.via, ['return-claim'], 'touched ROUTED_ELSEWHERE counts as nothing');
  const touchedNow = run(snapshot({ first: 'ROUTED_ELSEWHERE', firstUntouched: true, reroute: true }), release('ROUTED_ELSEWHERE', false));
  assert.deepEqual(touchedNow.via, ['return-claim'], 'a touched second release does not complete an untouched pair');
  for (const other of ['BLOCKED', 'BUDGET']) {
    const earlier = run(snapshot({ first: other, firstUntouched: true, reroute: true }), release('INELIGIBLE', true));
    assert.deepEqual(earlier.via, ['return-claim'], `an untouched ${other} is not counted`);
    const now = run(snapshot({ first: 'INELIGIBLE', firstUntouched: true, reroute: true }), release(other, true));
    assert.deepEqual(now.via, ['return-claim'], `an untouched ${other} now is not counted`);
  }
});

test('clause 2: with the setting off, ROUTED_ELSEWHERE never counts, touched or not, and the touched INELIGIBLE and BLOCKED pairs behave as before [C7]', () => {
  for (const untouched of [false, true]) {
    const result = run(snapshot({ first: 'ROUTED_ELSEWHERE', firstUntouched: untouched, reroute: false }), release('ROUTED_ELSEWHERE', untouched));
    assert.deepEqual(result.via, ['return-claim']);
  }
  const blockedTwice = run(snapshot({ first: 'BLOCKED', firstUntouched: false, reroute: false }), release('BLOCKED', false));
  assert.ok(blockedTwice.via.includes('released-twice'), 'two touched BLOCKED releases still count');
  const ineligibleTwice = run(snapshot({ first: 'INELIGIBLE', firstUntouched: false, reroute: false }), release('INELIGIBLE', false));
  assert.ok(ineligibleTwice.via.includes('released-twice'), 'two touched INELIGIBLE releases still count');
});
