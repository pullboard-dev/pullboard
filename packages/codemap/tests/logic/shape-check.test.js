/** @pullboard-test-input packages/codemap/src/logic/contracts/shape.js */
/** A shape checker reports a mismatch between an export and its declared shape, and a gap when none is declared [C7]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkShape } from '../../src/logic/contracts/shape.js';

const declared = { name: 'seal', params: ['key', 'text'], returns: 'string' };

test('codemap.shape-check.a-matching-export-gives-no: clause 1: a matching export gives no finding [C7]', () => {
  assert.equal(checkShape(declared, { ...declared }), null);
});

test('codemap.shape-check.a-differing-name-parameter-or: clause 1: a differing name, parameter or return shape names the export and the difference [C7]', () => {
  const name = checkShape(declared, { ...declared, name: 'unseal' });
  assert.equal(name.kind, 'mismatch');
  assert.match(name.difference, /unseal/u);
  const params = checkShape(declared, { ...declared, params: ['key'] });
  assert.deepEqual([params.kind, params.export], ['mismatch', 'seal']);
  assert.match(params.difference, /params: declared \(key, text\), actual \(key\)/u);
  const returns = checkShape(declared, { ...declared, returns: 'Buffer' });
  assert.match(returns.difference, /returns: declared string, actual Buffer/u);
});

test('codemap.shape-check.an-export-with-no-declared: clause 2: an export with no declared shape is a gap, not a mismatch [C7]', () => {
  const finding = checkShape(undefined, declared);
  assert.equal(finding.kind, 'gap');
  assert.equal(finding.export, 'seal');
});
