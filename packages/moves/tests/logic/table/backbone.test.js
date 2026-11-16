/** @pullboard-world-pin reads the state map fixture to prove the backbone table holds exactly its job kinds and serves words [C7,#8067]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MACHINE } from '../../../../state/light.js';
import { BACKBONE_RULES } from '../../../src/logic/table/backbone.table.js';
import { BACKBONE_STATES } from '../../../src/logic/table/backbone.table.js';
import { BACKBONE_TABLE } from '../../../src/logic/table/backbone.table.js';
import { JOB_KINDS } from '../../../src/logic/table/backbone.table.js';
import { servesRule } from '../../../src/logic/table/backbone.table.js';
import { deriveFact } from '../../../index.js';
import { explainTable } from '../../../index.js';
import { tableCoverage } from '../../../index.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../../../state/tests/fixtures/machines.json', import.meta.url), 'utf8'));

test('the backbone item rows are the declared moves, one row each, with no second list [C7,#8067]', () => {
  assert.equal(BACKBONE_TABLE.items.length, MACHINE.moves.length);
  const keys = BACKBONE_TABLE.items.map(row => row.key);
  assert.equal(new Set(keys).size, keys.length);
  MACHINE.moves.forEach((move, index) => assert.equal(BACKBONE_TABLE.items[index].key, `${move.verb}:${move.from.join('|')}>${move.to}`));
});

test('every job kind in the state map is one backbone row whose serves fact is a rule, and the words match the map [C7,#8067]', () => {
  assert.deepEqual(BACKBONE_TABLE.jobs.map(row => row.kind), FIXTURE.jobs.map(job => job.kind));
  assert.equal(BACKBONE_TABLE.jobs.length, 14);
  for (const job of FIXTURE.jobs) {
    const row = BACKBONE_TABLE.jobs.find(entry => entry.kind === job.kind);
    assert.equal(row.serves, servesRule(job.kind));
    assert.equal(BACKBONE_RULES[row.serves].says, job.serves);
    assert.equal(JOB_KINDS.find(entry => entry.kind === job.kind).serves, job.serves);
  }
});

test('serves facts derive over a snapshot and trace what they read [C7,#8067]', () => {
  const item = { status: 'claimed', owner: 's1', commit: 'c1', digest: 'd1' };
  const gate = deriveFact(BACKBONE_RULES, servesRule('gate'), { item, job: { kind: 'gate', seat: 's1', commit: 'c1', digest: 'd1' } });
  assert.equal(gate.holds, true);
  assert.deepEqual(gate.trace.map(step => step.fact), ['claimed', 'atJobCommit', 'serves.gate']);
  assert.equal(deriveFact(BACKBONE_RULES, servesRule('gate'), { item, job: { kind: 'gate', seat: 's2', commit: 'c1', digest: 'd1' } }).holds, false);
  assert.equal(deriveFact(BACKBONE_RULES, servesRule('main-test'), { job: { kind: 'main-test' } }).holds, true);
  assert.equal(deriveFact(BACKBONE_RULES, servesRule('main-test'), { item, job: { kind: 'main-test' } }).holds, false);
});

test('tableCoverage over the stored item statuses and job kinds reports no gap, and explain names every kind [C7,#8067]', () => {
  assert.deepEqual(BACKBONE_STATES, [...MACHINE.states.map(state => state.id), ...FIXTURE.jobs.map(job => job.kind)]);
  assert.equal(MACHINE.states.length, 5);
  assert.deepEqual(tableCoverage(BACKBONE_TABLE, BACKBONE_STATES).gaps, []);
  assert.deepEqual(tableCoverage(BACKBONE_TABLE, [...BACKBONE_STATES, 'invented-kind']).gaps, ['invented-kind']);
  assert.equal(explainTable(BACKBONE_TABLE, BACKBONE_RULES).table, 'backbone');
});
