/** @pullboard-test-input source-cell packages/moves */
/** A strict item lands and publishes in one step when the full-suite setting is on: landing reads none, then published, never landed [M2,#9326]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingEngine } from '../../../index.js';
import { landingOf } from '../../../index.js';
import { runTable } from '../../../index.js';

const ENGINE = landingEngine({ limits: { redLimit: 3, runnerSourceRetries: 2, staleProbes: 8 }, faultCodes: ['BOARD_BUSY'], repeatHold: 'landing-repeat-test:' });
const ID = 91;
const COMMIT = 'f'.repeat(40);
const SUITE = { kind: 'suite', suite: 'full', group: 'g1', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b2' };

/** A verified item in group g1 claimed under bar d1, with the suite setting on and a counting receipt. */
function snapshot(pace = 'strict') {
  const item = { id: ID, status: 'verified', mergedCommit: null, holdReason: null, commit: 'c1', checked: 'c1', after: [], pace, digest: 'd1', claimDigest: 'd1', group: 'g1' };
  return { now: '2026-11-16T10:00:00.000Z', base: 'b2', item, items: { [ID]: item }, batches: [], io: { suite: structuredClone(SUITE), strictFullSuite: true }, pace };
}
const merge = (s, extra = {}) => runTable(ENGINE.tables.merged, ENGINE.rules, structuredClone(s), { name: 'merged', id: ID, actor: 'coordinator', commit: COMMIT, ...extra });

test('moves.strict-publish.a-verified-strict-item-with-a-counting: clause 1: a verified strict item with a counting suite receipt reads none before the merge and published after it, never landed [M2,#9326]', () => {
  const s = snapshot();
  assert.equal(landingOf(s.item, []), 'none');
  const result = merge(s);
  assert.deepEqual(result.events.map(event => event.kind), ['merged', 'published']);
  assert.deepEqual(result.events[1].detail, { commit: COMMIT });
  assert.deepEqual(result.patch, { mergedCommit: COMMIT });
  assert.equal(landingOf({ mergedCommit: COMMIT }, result.events), 'published', 'the one move ends published, with no landed state left to read');
});

test('moves.strict-publish.a-strict-item-without-a-counting-suite: clause 2: a strict item without a counting suite receipt is refused LAND_SUITE_PENDING by the merged table [M2,#9326]', () => {
  for (const [why, edit] of [['no receipt', (s) => { s.io.suite = null; }], ['another group', (s) => { s.io.suite.group = 'g2'; }],
    ['older base', (s) => { s.io.suite.base = 'b1'; }], ['red', (s) => { s.io.suite.green = false; }]]) {
    const s = snapshot();
    edit(s);
    const result = merge(s);
    assert.deepEqual([result.refused?.code, result.refused?.row], ['LAND_SUITE_PENDING', 'strict-full-suite'], why);
  }
});

test('moves.strict-publish.a-steady-item-a-strict-item-with: clause 3: a steady item, a strict item with the setting off, and a forced merge keep the merged-only outcome [M2,#9326]', () => {
  const steady = snapshot('steady');
  steady.io = {};
  assert.deepEqual(merge(steady).events.map(event => event.kind), ['merged'], 'steady');
  const off = snapshot();
  off.io = { strictFullSuite: false };
  assert.deepEqual(merge(off).events.map(event => event.kind), ['merged'], 'strict with the setting off');
  const forced = snapshot();
  forced.io.suite = null;
  const result = merge(forced, { forced: 'coordinator hand landing' });
  assert.deepEqual(result.events.map(event => event.kind), ['merged'], 'forced');
  assert.equal(result.events[0].detail.forced, true);
});
