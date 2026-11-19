/** @pullboard-test-input source-cell packages/spec */
/** planRowApply writes a decision on a standard doctrine default into the repo doctrine file [C7,#2007,#11240]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { planRowApply } from '../../../index.js';

const loadDoctrine = () => ({ name: 'doctrine.txt' });
const config = { spec: 'SPEC.md' };
const LINE = '- PB2 [approved, strict] Every change names its proof.';
const record = { kind: 'doctrine', file: 'doctrine.txt', id: 'PB2', source: '', replacement: LINE, text: 'Every change names its proof.', decision: 'approve', reason: '' };

/** The checked-in repo root holding the named doctrine.txt; the plan reads it and never writes. */
const doctrineRoot = (name) => join(import.meta.dirname, '../../fixtures/row-decisions', name);

test('spec.row-decisions.standard-apply-appends: clause 1: planRowApply with one unapplied standard PB2 record and a doctrine file without PB2 returns one file change whose after text adds the replacement line once and changes no other line [C7,#2007]', () => {
  const plan = planRowApply(doctrineRoot('without'), config, [record], undefined, { loadDoctrine });
  assert.equal(plan.files.length, 1);
  assert.equal(plan.files[0].file, 'doctrine.txt');
  assert.equal(plan.files[0].after, `${plan.files[0].before}${LINE}\n`);
  assert.equal(plan.files[0].after.split('\n').filter((line) => line === LINE).length, 1);
});

test('spec.row-decisions.standard-apply-stale: clause 2: when the doctrine file already holds the same PB2 line the plan makes no change, and when it holds a different PB2 row the plan refuses STALE_ROW_DECISION [C7,#2007]', () => {
  assert.deepEqual(planRowApply(doctrineRoot('same'), config, [record], undefined, { loadDoctrine }).files, []);
  assert.throws(() => planRowApply(doctrineRoot('different'), config, [record], undefined, { loadDoctrine }), { code: 'STALE_ROW_DECISION' });
});
