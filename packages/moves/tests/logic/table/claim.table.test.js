/** @pullboard-test-input source-cell packages/moves */
/** The claim table refuses an item whose needs the claiming seat's abilities do not cover, and claims as before when there is no need [U136,C7,#1888]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boardClaimEngine } from '../../../index.js';
import { CLAIM_NEXT } from '../../../index.js';
import { runTable } from '../../../index.js';
import claimMove from '../../../src/logic/moves/claim.js';

const { rules: RULES, table: TABLE } = boardClaimEngine();

/** One open item in the seat's lane, with every fact a fresh claim reads in its passing state. */
function snapshot({ needs, abilities } = {}) {
  const item = { status: 'open', owner: null, gateInFlight: false, leaseUntil: null, verdict: null, builtBy: null, frozenDigest: null, parentId: null, lane: 'core', route: 'strong',
    diagnosed: true, holdReason: null, outside: null, after: [], expectedMinutes: null, returnedRework: false, ...(needs === undefined ? {} : { needs }) };
  const actor = { id: 'w1', lane: 'core', route: 'strong', joined: true, ...(abilities === undefined ? {} : { abilities }) };
  const io = { checkoutOwner: null, coordinatorPaths: [], provesNothing: null, policyRefresh: null, reworkWindows: true, exitCeiling: null, ledgerWritable: true, sessionCap: null,
    sessionSeats: [], laneSeat: null, primaryRoot: null, foreignBlocker: null, builderGone: false, buildBudgetMinutes: 30, seatCap: null, freeze: { text: 'bar text', digest: 'd1' }, head: 'h1', autoNextSnapshot: null };
  const deferred = { barProblem: null, reworkRouting: null, exitContinuation: null, lineCapacity: null, submitAdmission: null, submitOutcome: null };
  return { now: '2026-11-19T12:00:00.000Z', actor, item, items: {}, claimWaiting: [], laneHold: null, actorClaims: [], history: [], usedExitKeys: [], io, deferred };
}
const MOVE = { id: 40, actor: 'w1', leaseMs: 60_000, itemFolder: false, autoNext: false, reviewSkipped: null, adoptCorrection: false, routeCap: null, exitRules: null, exitClaimKey: null, factId: 900 };
const run = (s) => runTable(TABLE, RULES, structuredClone(s), structuredClone(MOVE));

test('moves.claim-table.needs-ability: clause 1: the claim table refuses NEEDS_ABILITY, naming the missing needs, when item needs hold a need the actor abilities lack, and claims as today when needs is empty or absent [C7,U136]', () => {
  const lacking = run(snapshot({ needs: ['browser', 'gui'], abilities: ['gui'] }));
  assert.equal(lacking.refused?.code, 'NEEDS_ABILITY');
  assert.equal(lacking.refused.row, 'abilities-cover-needs');
  assert.match(lacking.refused.message, /#40 needs browser,? /u);
  assert.doesNotMatch(lacking.refused.message, /gui/u, 'a need the seat covers is not named');
  assert.equal(lacking.refused.next, CLAIM_NEXT.NEEDS_ABILITY);
  assert.match(run(snapshot({ needs: ['browser', 'gui'] })).refused.message, /browser and gui/u, 'absent abilities read as none');
  for (const [name, input] of [['covered', { needs: ['browser'], abilities: ['gui', 'browser'] }], ['empty needs', { needs: [], abilities: [] }], ['absent needs', { abilities: ['gui'] }], ['neither', {}]]) {
    const claimed = run(snapshot(input));
    assert.ok(!claimed.refused, `${name} claims as today`);
  }
});

test('moves.claim-table.needs-ability-next: [C7,U136] the claim descriptor nextSteps and CLAIM_NEXT carry NEEDS_ABILITY with the same next step', () => {
  assert.equal(typeof CLAIM_NEXT.NEEDS_ABILITY, 'string');
  assert.equal(claimMove.nextSteps.NEEDS_ABILITY, CLAIM_NEXT.NEEDS_ABILITY);
});
