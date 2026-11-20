/** @pullboard-test-input packages/kernel/src/logic/failure/diagnostics.js */
/** A failing TAP case written with Node's \# and \\ escapes keeps its unescaped name and its signature [C7,V4]. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { caseSignatures } from '../../../src/logic/failure/diagnostics.js';
import { tapFailureDiagnostics } from '../../../src/logic/failure/diagnostics.js';

const NAME = 'tap escape [C7,#1] a\\b';
const digest = text => createHash('sha256').update(text).digest('hex');
const OUTPUT = ['TAP version 13',
  'not ok 1 - tap escape [C7,\\#1] a\\\\b',
  '  ---',
  '  duration_ms: 1',
  "  location: '/r/tests/x.test.js:3:1'",
  "  failureType: 'testCodeFailure'",
  "  error: 'Expected values to be strictly equal'",
  "  code: 'ERR_ASSERTION'",
  '  ...',
  '1..1', '# fail 1', ''].join('\n');

test('kernel.failure-diagnostics.tap-escaped-name: clause 1: a TAP case written with \\# and \\\\ reads back unescaped with a signature [C7]', () => {
  const rows = tapFailureDiagnostics(OUTPUT, '/r', digest);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, NAME);
  assert.match(rows[0].signature ?? '', /^[a-f0-9]{64}$/u);
});

test('kernel.failure-diagnostics.tap-escaped-signature: clause 2: caseSignatures finds the unescaped case its signature [C7]', () => {
  const rows = tapFailureDiagnostics(OUTPUT, '/r', digest);
  const [signature] = caseSignatures([{ name: NAME }], rows);
  assert.ok(signature);
  assert.equal(signature, rows[0].signature);
});
