/** spec check refuses an approved source-backed fact whose quote is missing or lacks the value, behind spec.requireFactQuote [B2,#9551]. @pullboard-test-input source-cell packages/spec */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  lintSpec,
  parseSpec,
} from '../../index.js';

/** A one-row spec whose row is an approved fact with the given trailing fields. */
function specWith(fields) {
  return parseSpec(`# Spec\n\n## G · Goals\n\n- G1 [approved, must] It ran 31 years. | gate: review | source: Report p.4${fields}\n`);
}

const GOOD = ' | quote: The programme ran for 31 years in all.';

test('clause 1: with requireFactQuote on, an approved fact with a source and no quote is refused [B2,#9551]', () => {
  const findings = lintSpec(specWith(''), { requireFactQuote: true });
  assert.equal(findings.length, 1);
  assert.equal(findings[0].level, 'error');
  assert.equal(findings[0].id, 'G1');
  assert.match(findings[0].message, /needs the words it rests on/u);
});

test('clause 1: with requireFactQuote on, a quote that lacks the value is refused and one that holds it passes [B2,#9551]', () => {
  const wrong = lintSpec(specWith(' | quote: The programme ran for a long time.'), { requireFactQuote: true });
  assert.equal(wrong.length, 1);
  assert.match(wrong[0].message, /does not contain 31/u);
  assert.deepEqual(lintSpec(specWith(GOOD), { requireFactQuote: true }), []);
});

test('clause 1: with requireFactQuote on, rows that are not approved or name no source are left alone [B2,#9551]', () => {
  const draft = parseSpec('# Spec\n\n## G · Goals\n\n- G1 [draft, must] It ran 31 years. | gate: review | source: Report p.4\n');
  const plain = parseSpec('# Spec\n\n## G · Goals\n\n- G1 [approved, must] It ran 31 years. | gate: review\n');
  assert.deepEqual(lintSpec(draft, { requireFactQuote: true }), []);
  assert.deepEqual(lintSpec(plain, { requireFactQuote: true }), []);
});

test('clause 1: with requireFactQuote off (default) nothing changes for a missing or wrong quote [B2,#9551]', () => {
  assert.deepEqual(lintSpec(specWith('')), []);
  assert.deepEqual(lintSpec(specWith(' | quote: Nothing relevant.')), []);
  assert.deepEqual(lintSpec(specWith(''), { requireFactQuote: false }), []);
});
