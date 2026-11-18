/** A red gate fact keeps the failing part's name and first failing cases, shortening the file list from its tail [C7,#9429]. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failingParts } from '../../../api/index.js';

const FILES = Array.from({ length: 200 }, (_, index) => `packages/gate/tests/generated-${index}.test.js`);

test('gate.red-fact-text.long-receipt-names-part: clause 1: a long red receipt records the part name and first failing case, and drops the tail of the file list [C7]', () => {
  const error = `exit 1: not ok first-case-name (packages/gate/tests/s.test.js) files: ${JSON.stringify(FILES)}`;
  const [part, ...rest] = failingParts({ status: 1, gate: { green: false, error } });
  assert.equal(rest.length, 0);
  assert.ok(part.startsWith('gate: exit 1: not ok first-case-name (packages/gate/tests/s.test.js) files: ["packages/gate/tests/generated-0.test.js"'));
  assert.ok(part.endsWith(' ...'));
  assert.ok(!part.includes('generated-199'));
});

test('gate.red-fact-text.short-receipt-unchanged: clause 2: a short red receipt is recorded unchanged [C7]', () => {
  assert.deepEqual(failingParts({ status: 1, gate: { green: false, error: 'exit 1: not ok one case' } }), ['gate: exit 1: not ok one case']);
});
