/** @pullboard-test-input source-cell packages/spec */
/** planRowApply writes a decision on a standard doctrine default into the repo doctrine file [C7,#2007,#11240]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { privateFixtureFiles } from '../../../../../apps/cli/tests/fixtures/child.js';
import { planRowApply } from '../../../index.js';

const loadDoctrine = () => ({ name: 'DOCTRINE.md' });
const config = { spec: 'SPEC.md' };
const LINE = '- PB2 [approved, strict] Every change names its proof.';
const record = { kind: 'doctrine', file: 'DOCTRINE.md', id: 'PB2', source: '', replacement: LINE, text: 'Every change names its proof.', decision: 'approve', reason: '' };

/** Run body against a scratch repo whose DOCTRINE.md holds the given text. */
function withDoctrine(text, body) {
  const files = privateFixtureFiles('pullboard-spec-row-decisions-');
  files.write('DOCTRINE.md', text);
  body(files.root);
}

test('spec.row-decisions.standard-apply-appends: clause 1: planRowApply with one unapplied standard PB2 record and a DOCTRINE.md without PB2 returns one file change whose after text adds the replacement line once and changes no other line [C7,#2007]', () => {
  const before = '## Rules\n- PB1 [approved] Keep it small.\n';
  withDoctrine(before, (root) => {
    const plan = planRowApply(root, config, [record], undefined, { loadDoctrine });
    assert.equal(plan.files.length, 1);
    assert.equal(plan.files[0].file, 'DOCTRINE.md');
    assert.equal(plan.files[0].after, `${before}${LINE}\n`);
    assert.equal(plan.files[0].after.split('\n').filter((line) => line === LINE).length, 1);
  });
});

test('spec.row-decisions.standard-apply-stale: clause 2: when DOCTRINE.md already holds the same PB2 line the plan makes no change, and when it holds a different PB2 row the plan refuses STALE_ROW_DECISION [C7,#2007]', () => {
  withDoctrine(`## Rules\n${LINE}\n`, (root) => {
    assert.deepEqual(planRowApply(root, config, [record], undefined, { loadDoctrine }).files, []);
  });
  withDoctrine('## Rules\n- PB2 [wont] Not here.\n', (root) => {
    assert.throws(() => planRowApply(root, config, [record], undefined, { loadDoctrine }), { code: 'STALE_ROW_DECISION' });
  });
});
