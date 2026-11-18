/** A sprint item lands only once screened on its base, with its bar unchanged since claim; steady landing reads neither [M2,V3]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingEngine } from '../../../index.js';
import { runTable } from '../../../index.js';

/** The limits, fault codes and hold prefix the landing cell would hand in, written here so the test restates rather than imports them. */
const ENGINE = landingEngine({ limits: { redLimit: 3, runnerSourceRetries: 2, staleProbes: 8 }, faultCodes: ['BOARD_BUSY'], repeatHold: 'landing-repeat-test:' });
const ID = 80;
const SCREEN = { kind: 'screen', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b2', checks: { secrets: 'green', hooks: 'green' } };

/** A submitted sprint item claimed under bar d1, screened green at its commit on base b2, the current base. */
function snapshot(pace = 'sprint') {
  const item = { id: ID, status: 'submitted', mergedCommit: null, holdReason: null, commit: 'c1', checked: 'c1', after: [], pace, digest: 'd1', claimDigest: 'd1' };
  return { now: '2026-11-16T10:00:00.000Z', base: 'b2', item, items: { [ID]: item }, batches: [], waivers: [], unverified: [], collisionFree: false,
    io: { screen: structuredClone(SCREEN) }, picked: { count: 0, touched: {} }, pace };
}
const select = (s) => runTable(ENGINE.tables.select, ENGINE.rules, structuredClone(s), { name: 'select', id: ID });

test('moves.landing-screen.a-sprint-item-with-a-screen-receipt: clause 1: a sprint item with a screen receipt from an older base is refused at landing-select with SCREEN_PENDING [M2,V3]', () => {
  assert.deepEqual(select(snapshot()).via, ['ready'], 'screened on the current base, it lands');
  const s = snapshot();
  s.io.screen.base = 'b1';
  assert.deepEqual([select(s).refused?.code, select(s).refused?.row], ['SCREEN_PENDING', 'screened']);
  s.io.screen = null;
  assert.equal(select(s).refused?.code, 'SCREEN_PENDING', 'no screen at all');
});

test('moves.landing-screen.a-sprint-item-whose-bar-changed-since: clause 2: a sprint item whose bar changed since claim is refused with CRITERIA_CHANGED [M2,V3]', () => {
  const s = snapshot();
  s.item.digest = 'd2';
  s.io.screen.digest = 'd2';
  assert.deepEqual([select(s).refused?.code, select(s).refused?.row], ['CRITERIA_CHANGED', 'a6-bar-frozen']);
});

test('moves.landing-screen.case-8865-steady-reads-neither-the-screen-nor: #8865: steady reads neither the screen nor the Always rows, and a screen without the trusted re-check does not land a sprint item [M2,V3]', () => {
  const steady = { ...snapshot('steady'), io: {} };
  steady.item.status = 'verified';
  steady.item.claimDigest = 'd0';
  assert.deepEqual(select(steady).via, ['ready'], 'a steady verified item lands with no screen, as today');
  const s = snapshot();
  s.io.screen.checks.secrets = 'red';
  assert.deepEqual([select(s).refused?.code, select(s).refused?.row], ['LAND_UNCHECKED', 'a8-irreversible']);
});
