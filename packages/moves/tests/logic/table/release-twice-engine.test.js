/** @pullboard-test-input source-cell packages/moves */
/** releasedTwice skips --on and machine-fault releases only from the release-twice engine; older boards replay as before [C7,#9832]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseEngine } from '../../../index.js';
import { runTable } from '../../../index.js';

const FROM = 20;
const { rules: RULES, table: TABLE } = releaseEngine({
  reasons: ['INELIGIBLE', 'ROUTED_ELSEWHERE', 'BLOCKED', 'BUDGET', 'TAKEN_OVER', 'DIAGNOSIS_WRONG', 'INFRA', 'OTHER'],
  staleLimits: () => ({ claim: 3_600_000, blocker: 900_000 }),
  releaseTwiceEngine: FROM,
});
const NOW = '2026-11-16T12:00:00.000Z';
const HOLDER = 'core-1';
const INFRA = 'GATE_INFRA_EXHAUSTED: the gate ran out of runners';

/** A claimed item the holder already handed back once (a touched BLOCKED release), then claimed again, at the given recorded engine. */
function snapshot(engine) {
  const history = [
    { id: 1, kind: 'claim', by: HOLDER, detail: {} },
    { id: 2, kind: 'release', by: HOLDER, detail: { reasonCode: 'BLOCKED' } },
    { id: 3, kind: 'claim', by: HOLDER, detail: {} },
  ];
  return {
    ...(engine === undefined ? {} : { engine }),
    revision: 3, actor: { id: HOLDER, route: 'light', joined: true }, owner: null, diagnosed: false, firstRefusalBuilder: null,
    item: { id: 7, status: 'claimed', owner: HOLDER, route: 'light', after: [], leaseUntil: '2026-11-16T13:00:00.000Z', holdReason: null, holdBy: null, reviewer: null },
    items: { 7: { status: 'claimed', after: [] }, 8: { status: 'open', after: [] } }, history, ownerLastClaimId: 3, ownerLastLease: null, ownerRegisteredPath: '/seats/core-1',
    lastClaim: { id: 3, kind: 'claim', by: HOLDER, detail: {} }, io: {},
  };
}

const infraRelease = { id: 7, actor: HOLDER, root: '/seats/core-1', reason: 'BLOCKED', note: INFRA, now: NOW, worktreeSnapshot: { head: 'h', digest: 'd' } };
const onRelease = { id: 7, actor: HOLDER, root: '/seats/core-1', reason: 'BLOCKED', on: [8], now: NOW, worktreeSnapshot: { head: 'h', digest: 'd' } };
const run = (s, m) => runTable(TABLE, RULES, structuredClone(s), structuredClone(m));
const twice = result => result.via.includes('released-twice');

test('clause 1: from the release-twice engine, a release naming --on or an infra-fault note does not count toward releasedTwice [C7,#9832]', () => {
  for (const engine of [FROM, FROM + 3, undefined]) {
    for (const [name, move] of [['infra note', infraRelease], ['--on', onRelease]]) {
      const result = run(snapshot(engine), move);
      assert.equal(result.refused, undefined, `${name} at engine ${engine}`);
      assert.ok(!twice(result), `${name} at engine ${engine} is not the second chosen release`);
    }
  }
  const plain = run(snapshot(FROM), { ...infraRelease, note: 'x' });
  assert.ok(twice(plain), 'an ordinary second release still counts at the new engine');
});

test('clause 2: the same two releases on a board at an older engine still count, as before [C7,#9832]', () => {
  for (const engine of [FROM - 1, 1, null]) {
    for (const [name, move] of [['infra note', infraRelease], ['--on', onRelease]]) {
      const result = run(snapshot(engine), move);
      assert.equal(result.refused, undefined, `${name} at engine ${engine}`);
      assert.ok(twice(result), `${name} at engine ${engine} still counts`);
    }
  }
});

test('clause 2: an earlier release in the history that named --on or an infra note counts at an older engine and not at the new one [C7,#9832]', () => {
  for (const detail of [{ reasonCode: 'BLOCKED', blockedOn: [8] }, { reasonCode: 'BLOCKED', reason: INFRA }]) {
    const base = snapshot(FROM);
    base.history[1] = { id: 2, kind: 'release', by: HOLDER, detail };
    const second = { ...infraRelease, note: 'x' };
    assert.ok(!twice(run(base, second)), `${JSON.stringify(detail)} is not counted at the new engine`);
    assert.ok(twice(run({ ...base, engine: FROM - 1 }, second)), `${JSON.stringify(detail)} is counted at an older engine`);
  }
});
