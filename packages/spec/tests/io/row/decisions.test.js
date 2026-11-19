/** @pullboard-test-input source-cell packages/spec */
/** planRowApply and prepareRowDecisions handle a decision on a standard doctrine default [C7,#2007,#11239,#11240]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { join } from 'node:path';
import { planRowApply } from '../../../index.js';
import { prepareRowDecisions } from '../../../index.js';

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

const ROOT = '/pullboard-fixture-repo-without-files';
const CONFIG = { spec: 'SPEC.md' };

/** A doctrine whose repo file holds no PB2 row, composed with the standard default PB2. */
function standardDoctrine() {
  const standard = { id: 'PB2', status: 'approved', tier: 'must', text: 'Every change ships through review.', origin: 'standard', line: 1 };
  return { name: 'DOCTRINE.md', repo: { name: 'DOCTRINE.md', rows: [] }, rows: [standard] };
}

/** The injected port, with the same two lines the doctrine cell's standardDecisionLine writes. */
function standardDecisionLine(row, { decision, reason = '' }) {
  return decision === 'approve' ? `- ${row.id} [approved, ${row.tier}] ${row.text}` : `- ${row.id} [wont] ${reason.trim()}`;
}

const decide = (ids, extra, ports = { loadDoctrine: standardDoctrine, standardDecisionLine }) => prepareRowDecisions(ROOT, CONFIG, { ids, on: '2026-11-19T00:00:00.000Z', sshSign: false, ...extra }, ports);

test('spec.row-decisions.standard-approve-record: clause 1: approving doctrine:PB2, absent from the repo file, records a standard row with an empty source and the port line [C7]', () => {
  const records = decide(['doctrine:PB2'], { decision: 'approve' });
  assert.equal(records.length, 1);
  assert.equal(records[0].kind, 'doctrine');
  assert.equal(records[0].id, 'PB2');
  assert.equal(records[0].standard, true);
  assert.equal(records[0].source, '');
  assert.equal(records[0].replacement, '- PB2 [approved, must] Every change ships through review.');
});

test('spec.row-decisions.standard-decline-record: clause 2: declining doctrine:PB2 with a reason records the wont line carrying that reason [C7]', () => {
  const [record] = decide(['doctrine:PB2'], { decision: 'decline', reason: 'we deploy by hand' });
  assert.equal(record.replacement, '- PB2 [wont] we deploy by hand');
  assert.equal(record.decision, 'decline');
  assert.equal(record.reason, 'we deploy by hand');
});

test('spec.row-decisions.unknown-id-still-refused: clause 3: an id that is neither a repo row nor a standard row still refuses NO_ROW [C7]', () => {
  assert.throws(() => decide(['doctrine:ZZ9'], { decision: 'approve' }), { code: 'NO_ROW' });
  assert.throws(() => decide(['doctrine:PB2'], { decision: 'approve' }, { loadDoctrine: standardDoctrine }), { code: 'NO_ROW' });
});
