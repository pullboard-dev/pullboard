/** The generated-test kit: seeded cases, unreached rows, writing refusals and metamorphic breaks [C7,#8066]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineRules } from '../../../index.js';
import { breakOne } from '../../../index.js';
import { seeded } from '../../../index.js';
import { tableCases } from '../../../index.js';
import { runTable } from '../../../index.js';

const RULES = defineRules({
  claimed: { says: 'the item is claimed', holds: s => s.item.status === 'claimed' },
  mine: { says: 'the caller holds it', holds: (s, m) => s.item.owner === m.actor },
  noted: { says: 'a note came', holds: (_s, m) => Boolean(m.note) },
});
const TABLE = {
  name: 'release',
  guards: [
    { id: 'claimed', requires: 'claimed', code: 'NOT_CLAIMED', message: 'm', next: 'n' },
    { id: 'mine', requires: 'mine', code: 'NOT_YOURS', message: 'm', next: 'n' },
  ],
  outcomes: [
    { id: 'noted', when: 'noted', patch: () => ({ status: 'open' }), events: () => [{ kind: 'release' }] },
    { id: 'plain', patch: () => ({ status: 'open' }), events: () => [] },
  ],
  followups: [],
};
const BREAKS = {
  claimed: (snapshot, move) => ({ snapshot: { ...snapshot, item: { ...snapshot.item, status: 'open' } }, move }),
  mine: (snapshot, move) => ({ snapshot, move: { ...move, actor: 'someone-else' } }),
  noted: (snapshot, move) => ({ snapshot, move: { ...move, note: '' } }),
};
/** Mostly valid cases, sometimes a stranger or an open item. */
const generate = (g) => ({
  snapshot: { item: { status: g.int(5) === 0 ? 'open' : 'claimed', owner: g.int(4) === 0 ? 'b' : 'a' } },
  move: { name: 'release', actor: 'a', note: g.int(2) ? 'why' : '' },
  breaks: BREAKS,
});

test('moves.cases.seeded-gives-the-same-sequence-for-the: seeded gives the same sequence for the same seed and a different one for another [C7,#8066]', () => {
  const take = seed => { const g = seeded(seed); return [g.rand(), g.rand(), g.int(100)]; };
  assert.deepEqual(take(7), take(7));
  assert.notDeepEqual(take(7), take(8));
});

test('moves.cases.table-cases-reports-every-guard-or-outcome-no: tableCases reports every guard or outcome no generated case reaches [C7,#8066]', () => {
  const full = tableCases(TABLE, RULES, generate, { seed: 1, count: 200 });
  assert.deepEqual(full.unreached, { guards: [], outcomes: [], followups: [] });
  const only = tableCases(TABLE, RULES, () => ({ snapshot: { item: { status: 'open', owner: 'a' } }, move: { actor: 'a' } }), { seed: 1, count: 5 });
  assert.deepEqual(only.unreached.guards, ['mine']);
  assert.deepEqual(only.unreached.outcomes, ['noted', 'plain']);
});

test('moves.cases.table-cases-reports-a-refusal-that-returns-a: tableCases reports a refusal that returns a patch or events, and none for a sound engine [C7,#8066]', () => {
  assert.deepEqual(tableCases(TABLE, RULES, generate, { seed: 3, count: 100 }).writingRefusals, []);
  const leaky = (table, rules, snapshot, move) => {
    const result = runTable(table, rules, snapshot, move);
    return result.refused ? { ...result, events: [{ kind: 'oops' }] } : result;
  };
  const report = tableCases(TABLE, RULES, generate, { seed: 3, count: 100, run: leaky });
  assert.equal(report.writingRefusals.length > 0, true);
  assert.equal(report.writingRefusals[0].row === 'claimed' || report.writingRefusals[0].row === 'mine', true);
});

test('moves.cases.table-cases-reports-a-broken-fact-that-does: tableCases reports a broken fact that does not refuse, when the engine ignores the guard [C7,#8066]', () => {
  const blind = (table, rules, snapshot, move) => runTable({ ...table, guards: [] }, rules, snapshot, move);
  const report = tableCases(TABLE, RULES, generate, { seed: 3, count: 100, run: blind });
  assert.equal(report.unbroken.length > 0, true);
});

test('moves.cases.the-same-seed-gives-the-same-report: the same seed gives the same report [C7,#8066]', () => {
  assert.deepEqual(tableCases(TABLE, RULES, generate, { seed: 9, count: 50 }), tableCases(TABLE, RULES, generate, { seed: 9, count: 50 }));
});

test('moves.cases.break-one-turns-a-valid-outcome-into-a: breakOne turns a valid outcome into a refusal when a guard requires the broken fact, else it stays valid [C7,#8066]', () => {
  const made = generate(seeded(1)); made.snapshot = { item: { status: 'claimed', owner: 'a' } }; made.move = { name: 'release', actor: 'a', note: 'why' };
  assert.equal(runTable(TABLE, RULES, structuredClone(made.snapshot), made.move).refused, undefined);
  for (const fact of ['claimed', 'mine']) {
    const broken = breakOne(made, fact);
    assert.equal(runTable(TABLE, RULES, broken.snapshot, broken.move).refused.fact, fact);
  }
  const unrelated = breakOne(made, 'noted');
  assert.equal(runTable(TABLE, RULES, unrelated.snapshot, unrelated.move).refused, undefined);
  assert.equal(made.snapshot.item.status, 'claimed');
  assert.throws(() => breakOne(made, 'ghost'), /ghost/);
});
