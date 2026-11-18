/** @pullboard-test-input source-cell packages/moves */
/** A strict item lands only with its group's counting full-suite receipt when the setting is on; steady and sprint are never asked [M2,#9325]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingEngine } from '../../../index.js';
import { runTable } from '../../../index.js';

const ENGINE = landingEngine({ limits: { redLimit: 3, runnerSourceRetries: 2, staleProbes: 8 }, faultCodes: ['BOARD_BUSY'], repeatHold: 'landing-repeat-test:' });
const ID = 90;
const SCREEN = { kind: 'screen', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b2', checks: { secrets: 'green', hooks: 'green' } };
const SUITE = { kind: 'suite', suite: 'full', group: 'g1', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b2' };

/** A verified strict item in group g1 claimed under bar d1, with the suite setting on and a counting receipt. */
function snapshot(pace = 'strict') {
  const item = { id: ID, status: 'verified', mergedCommit: null, holdReason: null, commit: 'c1', checked: 'c1', after: [], pace, digest: 'd1', claimDigest: 'd1', group: 'g1' };
  return { now: '2026-11-16T10:00:00.000Z', base: 'b2', item, items: { [ID]: item }, batches: [], waivers: [], unverified: [], collisionFree: false,
    io: { screen: structuredClone(SCREEN), suite: structuredClone(SUITE), strictFullSuite: true }, picked: { count: 0, touched: {} }, pace };
}
const select = (s) => runTable(ENGINE.tables.select, ENGINE.rules, structuredClone(s), { name: 'select', id: ID });

test('moves.strict-suite-select.a-strict-item-with-a-counting-full: clause 1: a strict item with a counting full-suite receipt is picked by landing-select [M2,#9325]', () => {
  assert.deepEqual(select(snapshot()).via, ['ready']);
});

test('moves.strict-suite-select.a-strict-item-without-a-counting-full: clause 2: a strict item without a counting full-suite receipt is refused LAND_SUITE_PENDING naming the full suite [M2,#9325]', () => {
  for (const [why, edit] of [['no receipt', (s) => { s.io.suite = null; }], ['another group', (s) => { s.io.suite.group = 'g2'; }],
    ['older base', (s) => { s.io.suite.base = 'b1'; }], ['red', (s) => { s.io.suite.green = false; }]]) {
    const s = snapshot();
    edit(s);
    const result = select(s);
    assert.deepEqual([result.refused?.code, result.refused?.row], ['LAND_SUITE_PENDING', 'strict-full-suite'], why);
    assert.match(result.refused?.message ?? '', /group g1/u, why);
    assert.match(result.refused?.next ?? '', /full suite/u, why);
  }
});

test('moves.strict-suite-select.a-steady-or-sprint-item-or-a: clause 3: a steady or sprint item, or a strict item with the setting off, is not asked for a receipt [M2,#9325]', () => {
  const steady = snapshot('steady');
  steady.io = {};
  assert.deepEqual(select(steady).via, ['ready'], 'steady');
  const sprint = snapshot('sprint');
  sprint.item.status = 'submitted';
  sprint.io.suite = null;
  assert.deepEqual(select(sprint).via, ['ready'], 'sprint');
  const off = snapshot();
  off.io.suite = null;
  off.io.strictFullSuite = false;
  assert.deepEqual(select(off).via, ['ready'], 'strict with the setting off');
});
