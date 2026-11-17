/** @pullboard-test-input source-cell packages/moves packages/state */
/** @pullboard-world-pin reads the state map fixture to prove the backbone table holds exactly its job kinds and serves words [C7,#8067]. */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { MACHINE } from '../../../../state/light.js';
import { BACKBONE_RULES } from '../../../src/logic/table/backbone.table.js';
import { BACKBONE_STATES } from '../../../src/logic/table/backbone.table.js';
import { BACKBONE_TABLE } from '../../../src/logic/table/backbone.table.js';
import { CREATED_JOB_KINDS } from '../../../src/logic/table/backbone.table.js';
import { JOB_KINDS } from '../../../src/logic/table/backbone.table.js';
import { servesRule } from '../../../src/logic/table/backbone.table.js';
import { deriveFact } from '../../../index.js';
import { explainTable } from '../../../index.js';
import { tableCoverage } from '../../../index.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../../../state/tests/fixtures/machines.json', import.meta.url), 'utf8'));

test('moves.backbone.the-backbone-item-rows-are-the-declared: the backbone item rows are the declared moves, one row each, with no second list [C7,#8067]', () => {
  assert.equal(BACKBONE_TABLE.items.length, MACHINE.moves.length);
  const keys = BACKBONE_TABLE.items.map(row => row.key);
  assert.equal(new Set(keys).size, keys.length);
  MACHINE.moves.forEach((move, index) => assert.equal(BACKBONE_TABLE.items[index].key, `${move.verb}:${move.from.join('|')}>${move.to}`));
});

test('moves.backbone.every-job-kind-in-the-state-map: every job kind in the state map is one backbone row whose serves fact is a rule, and the words match the map [C7,#8067]', () => {
  assert.deepEqual(CREATED_JOB_KINDS, FIXTURE.jobs.map(job => job.kind), 'the kinds the code creates are exactly the map\'s');
  assert.deepEqual(BACKBONE_TABLE.jobs.map(row => row.kind), FIXTURE.jobs.map(job => job.kind), 'the pull-out job is created by the lander, so the map names it too');
  assert.equal(BACKBONE_TABLE.jobs.length, 16);
  for (const job of FIXTURE.jobs) {
    const row = BACKBONE_TABLE.jobs.find(entry => entry.kind === job.kind);
    assert.equal(row.serves, servesRule(job.kind));
    assert.equal(BACKBONE_RULES[row.serves].says, job.serves);
    assert.equal(JOB_KINDS.find(entry => entry.kind === job.kind).serves, job.serves);
  }
});

test('moves.backbone.serves-facts-derive-over-a-snapshot-and: serves facts derive over a snapshot and trace what they read [C7,#8067]', () => {
  const item = { status: 'claimed', owner: 's1', commit: 'c1', digest: 'd1' };
  const gate = deriveFact(BACKBONE_RULES, servesRule('gate'), { item, job: { kind: 'gate', seat: 's1', commit: 'c1', digest: 'd1' } });
  assert.equal(gate.holds, true);
  assert.deepEqual(gate.trace.map(step => step.fact), ['claimed', 'atJobCommit', 'serves.gate']);
  assert.equal(deriveFact(BACKBONE_RULES, servesRule('gate'), { item, job: { kind: 'gate', seat: 's2', commit: 'c1', digest: 'd1' } }).holds, false);
  assert.equal(deriveFact(BACKBONE_RULES, servesRule('main-test'), { job: { kind: 'main-test' } }).holds, true);
  assert.equal(deriveFact(BACKBONE_RULES, servesRule('main-test'), { item, job: { kind: 'main-test' } }).holds, false);
});

test('moves.backbone.table-coverage-over-the-stored-item-statuses-and: tableCoverage over the stored item statuses and job kinds reports no gap, and explain names every kind [C7,#8067]', () => {
  assert.deepEqual(BACKBONE_STATES, [...MACHINE.states.map(state => state.id), ...FIXTURE.jobs.map(job => job.kind)]);
  assert.equal(MACHINE.states.length, 5);
  assert.deepEqual(tableCoverage(BACKBONE_TABLE, BACKBONE_STATES).gaps, []);
  assert.deepEqual(tableCoverage(BACKBONE_TABLE, [...BACKBONE_STATES, 'invented-kind']).gaps, ['invented-kind']);
  assert.equal(explainTable(BACKBONE_TABLE, BACKBONE_RULES).table, 'backbone');
});

test('moves.backbone.the-job-kinds-list-screen-with-a: clause 1: the job kinds list screen, with a serves rule naming a submitted sprint item at its commit and base [M1]', () => {
  const row = BACKBONE_TABLE.jobs.find(entry => entry.kind === 'screen');
  assert.deepEqual(row, { kind: 'screen', serves: 'serves.screen' });
  assert.match(BACKBONE_RULES[row.serves].says, /submitted sprint item at its commit on the current base/u);
  const item = { status: 'submitted', pace: 'sprint', commit: 'c1', digest: 'd1' };
  const job = { kind: 'screen', commit: 'c1', base: 'b1' };
  const serves = (snapshot) => deriveFact(BACKBONE_RULES, servesRule('screen'), snapshot).holds;
  assert.equal(serves({ item, job, base: 'b1' }), true);
  assert.deepEqual(deriveFact(BACKBONE_RULES, servesRule('screen'), { item, job, base: 'b1' }).trace.map(step => step.fact), ['submitted', 'serves.screen']);
  assert.equal(serves({ item: { ...item, pace: 'steady' }, job, base: 'b1' }), false, 'a steady item is never screened');
  assert.equal(serves({ item: { ...item, status: 'verified' }, job, base: 'b1' }), false, 'only submitted work');
  assert.equal(serves({ item: { ...item, commit: 'c2' }, job, base: 'b1' }), false, "only at the job's commit");
  assert.equal(serves({ item, job, base: 'b2' }), false, 'only on the current base');
});

test('moves.backbone.the-job-kinds-list-pull-out-serving-an: clause 1: the job kinds list pull-out, serving an item whose landing is pulling [M2,#8870]', () => {
  const row = BACKBONE_TABLE.jobs.find(entry => entry.kind === 'pull-out');
  assert.deepEqual(row, { kind: 'pull-out', serves: 'serves.pull-out' });
  assert.match(BACKBONE_RULES[row.serves].says, /landing is pulling/u);
  assert.equal(CREATED_JOB_KINDS.includes('pull-out'), true, 'runPullOutJob creates it [#9100]');
  const item = { status: 'open', commit: 'c1', mergedCommit: 'm1' };
  const job = { kind: 'pull-out' };
  const serves = (snapshot) => deriveFact(BACKBONE_RULES, servesRule('pull-out'), snapshot).holds;
  const pulling = [{ kind: 'merged' }, { kind: 'pull_out' }];
  assert.equal(serves({ item, job, history: pulling }), true);
  assert.equal(serves({ item, job, history: [{ kind: 'merged' }] }), false, 'landed work is not being pulled');
  assert.equal(serves({ item, job, history: [...pulling, { kind: 'pulled' }] }), false, 'a recorded revert ends the pull-out');
  assert.equal(serves({ item: null, job, history: pulling }), false, 'no item, nothing to pull');
  assert.equal(serves({ item, job: { kind: 'screen' }, history: pulling }), false);
});
