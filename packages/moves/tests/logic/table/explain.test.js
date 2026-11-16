/** explainTable lists the guards in order from the rule words; tableCoverage names states with no row [C7,#8065]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { defineRules } from '../../../index.js';
import { explainTable } from '../../../index.js';
import { tableCoverage } from '../../../index.js';

const RULES = defineRules({
  claimed: { says: 'the item is claimed', holds: () => true },
  mine: { says: 'the caller holds the claim', holds: () => true },
  noted: { says: 'the move carries a note', holds: () => true },
});
const TABLE = {
  name: 'release',
  states: { start: ['claimed'], refused: ['open'] },
  guards: [
    { id: 'claimed', requires: 'claimed', code: 'NOT_CLAIMED', message: 'm', next: 'claim it first' },
    { id: 'mine', requires: 'mine', code: 'NOT_YOURS', message: 'm', next: () => 'depends', refusesStates: ['submitted'] },
  ],
  outcomes: [{ id: 'noted', when: 'noted', patch: () => ({}), events: () => [] }, { id: 'plain', patch: () => ({}), events: () => [] }],
  followups: [{ id: 'tally', when: 'claimed', apply: () => ({ patch: {} }) }],
};

test('explainTable lists every guard in order with id, code, the fact words and next step, then the outcomes [C7,#8065]', () => {
  const out = explainTable(TABLE, RULES);
  assert.deepEqual(out.guards, [
    { order: 1, id: 'claimed', code: 'NOT_CLAIMED', fact: 'claimed', says: 'the item is claimed', next: 'claim it first' },
    { order: 2, id: 'mine', code: 'NOT_YOURS', fact: 'mine', says: 'the caller holds the claim', next: '(depends on the item)' },
  ]);
  assert.deepEqual(out.outcomes, [{ id: 'noted', fact: 'noted', says: 'the move carries a note' }, { id: 'plain', fact: null, says: 'otherwise' }]);
  assert.deepEqual(out.followups, [{ id: 'tally', fact: 'claimed', says: 'the item is claimed' }]);
});

test('explainTable refuses a table naming a fact no rule defines [C7,#8065]', () => {
  assert.throws(() => explainTable({ ...TABLE, guards: [{ id: 'x', requires: 'ghost', code: 'X', message: '', next: '' }] }, RULES), /ghost/);
});

test('tableCoverage names every stored state that is neither a legal start nor an explicit refusal [C7,#8065]', () => {
  const report = tableCoverage(TABLE, ['open', 'claimed', 'submitted', 'verified', 'withdrawn']);
  assert.deepEqual(report.gaps, ['verified', 'withdrawn']);
});

test('a table whose every state is covered reports no gap [C7,#8065]', () => {
  assert.deepEqual(tableCoverage(TABLE, ['open', 'claimed', 'submitted']).gaps, []);
});

test('clause 3: explaining a table for pace steady leaves out a sprint-only row, and with no pace lists it with its paces [M1]', () => {
  const paced = { ...TABLE, guards: [...TABLE.guards, { id: 'sprint-note', requires: 'noted', code: 'NOTE_NEEDED', message: 'm', next: 'add a note', paces: ['sprint'], always: 'A8' }] };
  const steady = explainTable(paced, RULES, { pace: 'steady' });
  assert.deepEqual(steady.guards.map(guard => guard.id), ['claimed', 'mine']);
  assert.deepEqual(steady, explainTable(TABLE, RULES));
  const sprint = explainTable(paced, RULES, { pace: 'sprint' });
  assert.deepEqual(sprint.guards.at(-1), { order: 3, id: 'sprint-note', code: 'NOTE_NEEDED', fact: 'noted', says: 'the move carries a note', next: 'add a note', paces: ['sprint'], always: 'A8' });
  assert.equal(explainTable(paced, RULES).guards.length, 3);
});
