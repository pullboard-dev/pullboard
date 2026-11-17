/** @pullboard-test-input source-cell packages/moves */
/** Generated over strict items: through the landing tables no strict item is ever seen landed while the full-suite setting publishes it; the paths that do not publish record merged only, so they read landed [M2,#8872]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { landingEngine } from '../../../index.js';
import { landingOf } from '../../../index.js';
import { runTable } from '../../../index.js';
import { seeded } from '../../../index.js';

const ENGINE = landingEngine({ limits: { redLimit: 3, runnerSourceRetries: 2, staleProbes: 8 }, faultCodes: ['BOARD_BUSY'], repeatHold: 'landing-repeat-test:' });
const NOW = '2026-11-16T12:00:00.000Z';
const COMMIT = 'f'.repeat(40);
const CASES = 400;
const run = (table, snapshot, move) => runTable(ENGINE.tables[table], ENGINE.rules, structuredClone(snapshot), structuredClone(move));

/** A verified strict item in group g1 with a green, trusted, leased full-suite receipt at its commit and digest on base b2; `g` varies what is true and harmless. */
function strictSnapshot(g, id) {
  const item = { id, status: 'verified', mergedCommit: null, holdReason: null, commit: 'c1', checked: g.pick(['c1', 'c1', 'c2']), after: [], pace: 'strict', digest: 'd1', claimDigest: 'd1', group: 'g1' };
  const suite = { kind: 'suite', suite: 'full', group: 'g1', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b2' };
  const screen = { kind: 'screen', green: true, trusted: true, leased: true, commit: 'c1', digest: 'd1', base: 'b2', checks: { secrets: 'green', hooks: 'green' } };
  return { now: NOW, base: 'b2', item, items: { [id]: item }, batches: [], waivers: [], unverified: [], picked: { count: 0, touched: {} }, collisionFree: g.pick([false, true]), pace: 'strict', io: { suite, screen, strictFullSuite: g.pick([true, false]) } };
}

/** The state a snapshot's item reads after a table result: the patch applied and the events appended. */
const reads = (s, result) => landingOf({ ...s.item, ...result.patch }, result.events);

test('clause 1: no strict item is ever seen landed through the select table, the setting on or off, or through the merged table with the setting on and a counting receipt [M2,#8872]', () => {
  let selected = 0, published = 0;
  for (let seed = 1; seed <= CASES; seed++) {
    const g = seeded(seed), id = 100 + seed;
    const s = strictSnapshot(g, id);
    const picked = run('select', s, { name: 'select', id });
    if (!picked.refused) {
      selected++;
      assert.equal(reads(s, picked), 'none', `seed ${seed}: select takes the item to a candidate, not to landed`);
    }
    const merged = run('merged', s, { name: 'merged', id, actor: 'coordinator', commit: COMMIT });
    if (s.io.strictFullSuite) {
      published++;
      assert.deepEqual(merged.events.map(event => event.kind), ['merged', 'published'], `seed ${seed}`);
      assert.equal(reads(s, merged), 'published', `seed ${seed}: setting on and a counting receipt publishes`);
    }
  }
  assert.ok(selected > 100 && published > 100, `only ${selected} selections and ${published} publishes`);
});

test('clause 2: the merged table with the setting off or without a publish, and the record table land outcome, emit only merged events, so landingOf reads landed [M2,#8872]', () => {
  for (let seed = 1; seed <= CASES; seed++) {
    const g = seeded(seed), id = 100 + seed;
    const s = strictSnapshot(g, id);
    s.io.strictFullSuite = false;
    const merged = run('merged', s, { name: 'merged', id, actor: 'coordinator', commit: COMMIT });
    assert.deepEqual(merged.events.map(event => event.kind), ['merged'], `seed ${seed}: setting off`);
    assert.equal(reads(s, merged), 'landed', `seed ${seed}: setting off reads landed`);
    s.io.strictFullSuite = true;
    const forced = run('merged', s, { name: 'merged', id, actor: 'coordinator', commit: COMMIT, forced: 'hand landed' });
    assert.deepEqual(forced.events.map(event => event.kind), ['merged'], `seed ${seed}: forced`);
    assert.equal(reads(s, forced), 'landed', `seed ${seed}: forced reads landed`);

    const entry = { id, commit: 'c1', reviewedCommit: s.item.checked, merge: COMMIT };
    const recordState = { now: NOW, lineage: null, batch: { id: 'b5', tip: 'tip1', state: 'pushed', items: [entry] }, items: { [id]: { ...s.item } }, lease: { holder: { token: 'k1', generation: 4, branch: 'main', lineage: null, until: '2026-11-16T12:01:00.000Z' } } };
    const recorded = run('record', recordState, { name: 'record', actor: 'coordinator', tip: 'tip1', fence: { token: 'k1', generation: 4, branch: 'main' } });
    assert.ok(!recorded.refused, `seed ${seed}: ${recorded.refused?.code}`);
    assert.deepEqual(recorded.events.filter(event => event.kind !== 'main-moved').map(event => event.kind), ['merged'], `seed ${seed}: record`);
    assert.equal(landingOf({ ...s.item, mergedCommit: COMMIT }, recorded.events), 'landed', `seed ${seed}: record reads landed`);
  }
});
